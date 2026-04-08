// Driver abstraction for taskora's Redis adapter.
//
// `RedisBackend` (the single shared implementation) talks only to a `RedisDriver`.
// Two implementations exist:
//   - `IoredisDriver` (drivers/ioredis.ts) — wraps a node-redis-compatible ioredis client
//   - `BunDriver`     (drivers/bun.ts)     — wraps Bun's built-in `Bun.RedisClient`
//
// The interface is intentionally narrow: a single generic `command()` escape hatch
// covers the ~25 dumb commands the backend uses, with typed methods only for things
// that have non-trivial semantics (Lua scripting + NOSCRIPT recovery, blocking
// commands, pipelines, pubsub, connection management).

/**
 * Argument type accepted by `command()` and Lua script invocations.
 *
 * `boolean` is intentionally excluded — booleans are a common source of bugs
 * (`true` becoming `"true"` instead of `1`); callers must coerce explicitly.
 */
export type RedisArg = string | number | Uint8Array;

/**
 * Result of a single `XREAD` / `XREAD BLOCK` call.
 *
 * Shape: `[[streamKey, [[entryId, [field, val, field, val, ...]], ...]], ...]`
 *
 * `null` when a `BLOCK` call timed out without any new entries.
 */
export type XReadResult = Array<[string, Array<[string, string[]]>]>;

/**
 * Unsubscribe handle returned by {@link RedisDriver.subscribe}.
 *
 * Calling it stops the subscription and releases the underlying connection
 * (or reverts the driver from "subscriber mode" depending on the driver).
 */
export type Unsubscribe = () => Promise<void>;

/**
 * Pipeline result tuple — matches ioredis's exact shape so call-sites can be
 * shared between drivers without per-driver branching.
 *
 * On success: `[null, value]`. On per-command failure: `[Error, null]`.
 * A failure of one command in the pipeline does NOT reject the whole batch
 * (this is what `getTaskKeyStats` relies on for tolerated `MEMORY USAGE` failures).
 */
export type PipelineResult = Array<[Error | null, unknown]>;

/**
 * Fluent batch builder. ioredis implements this natively via `client.pipeline()`;
 * Bun fakes it via `Promise.allSettled` (Bun's auto-pipelining coalesces same-tick
 * `.send()` calls into a single round trip, so the perf characteristics match).
 */
export interface PipelineBuilder {
  /** Queue a command into the batch. Returns `this` for chaining. */
  add(command: string, args: RedisArg[]): this;
  /**
   * Execute the queued commands. Resolves to a tuple-shaped array; never rejects
   * — per-command failures appear as `[Error, null]` in the result.
   */
  exec(): Promise<PipelineResult>;
}

/**
 * The minimum surface that `RedisBackend` needs from a Redis client.
 *
 * Implementations are thin wrappers — see `drivers/ioredis.ts` and `drivers/bun.ts`.
 * Connection ownership is NOT a driver concern; the factories (`src/redis/ioredis.ts`,
 * `src/redis/bun.ts`) decide whether to call `close()` based on whether the user
 * passed in their own client instance.
 */
export interface RedisDriver {
  /**
   * Generic command executor. Used for the ~25 "dumb" Redis commands the backend
   * issues (hash/list/zset/string/stream/scan/info ops). Returns the parsed RESP
   * value as `unknown`; call-sites cast to the expected shape.
   *
   * Drivers are expected to:
   *  - Coerce numeric args to strings if the underlying client requires it
   *  - Force RESP2-shaped responses (Bun must `HELLO 2` at connect, ioredis is RESP2 by default)
   *  - For `HGETALL` specifically, normalize the response to `Record<string, string>`
   *    (Bun returns flat array `[k,v,k,v,...]` under RESP2 — this conversion happens
   *    inside the driver so call-sites don't need to know which driver is in use)
   */
  command(name: string, args: RedisArg[]): Promise<unknown>;

  /**
   * Open a fluent pipeline. See {@link PipelineBuilder}.
   */
  pipeline(): PipelineBuilder;

  /**
   * Load a Lua script via `SCRIPT LOAD`. Returns the SHA the server assigned.
   *
   * Backends typically call this once at `connect()` time for all of their
   * registered scripts and cache the SHAs.
   */
  scriptLoad(source: string): Promise<string>;

  /**
   * Execute a previously-loaded Lua script.
   *
   * On `NOSCRIPT` (server's script cache evicted the SHA — happens after
   * `SCRIPT FLUSH` or restart), the driver MUST transparently:
   *   1. Re-`EVAL` the full source
   *   2. Re-load the script to obtain a new SHA
   *   3. Update its internal SHA mapping (if it maintains one)
   *   4. Return the result of step 1
   *
   * The backend does not see NOSCRIPT errors — that recovery logic lives here
   * to avoid duplicating it across driver implementations.
   */
  evalSha(sha: string, numKeys: number, args: RedisArg[], fallbackSource: string): Promise<unknown>;

  /**
   * Blocking `BZPOPMIN`. Returns `[key, member, score]` (all strings) or `null`
   * on timeout.
   *
   * MUST hold the connection until either an element is available or `timeoutSec`
   * elapses. Drivers should be called on a duplicated client — see {@link duplicate}.
   * The backend manages its own per-task pool of blocking clients.
   *
   * @param timeoutSec  Timeout in seconds. `0` means block forever.
   */
  blockingZPopMin(key: string, timeoutSec: number): Promise<[string, string, string] | null>;

  /**
   * Blocking `XREAD`. Returns the parsed stream entries or `null` on timeout.
   *
   * Same connection-takeover semantics as {@link blockingZPopMin}.
   *
   * @param streams  Stream keys to read from
   * @param ids      Last-seen entry IDs per stream (parallel to `streams`); use
   *                 `"$"` for "only entries added after this call started"
   * @param blockMs  Block timeout in milliseconds. `0` means block forever.
   * @param count    Maximum number of entries to return per stream
   */
  blockingXRead(
    streams: string[],
    ids: string[],
    blockMs: number,
    count: number,
  ): Promise<XReadResult | null>;

  /**
   * Subscribe to a Redis pub/sub channel.
   *
   * The handler receives only the message string — the caller already knows
   * which channel they subscribed to, so the channel argument would be redundant.
   *
   * IMPORTANT: once `subscribe` is called on a driver instance, that instance
   * may go into "subscriber mode" and reject normal commands (ioredis behavior).
   * Bun is more permissive and allows mixed use, but callers should not rely on
   * that — always use a {@link duplicate}d driver for subscriptions.
   *
   * Returns an unsubscribe function that closes the channel and releases resources.
   */
  subscribe(channel: string, handler: (message: string) => void): Promise<Unsubscribe>;

  /**
   * Create an independent driver bound to a separate connection to the same server.
   *
   * Used by the backend for:
   *   - Per-task `BZPOPMIN` blocking dequeue clients
   *   - The event reader's `XREAD BLOCK` loop
   *   - The job waiter's `XREAD BLOCK` loop
   *   - Pub/sub subscriptions (`onCancel`, `subscribe`)
   *
   * The duplicated driver inherits configuration but has its own socket; it can
   * be used while the original driver is busy with a blocking command.
   *
   * Note: Bun's `client.duplicate()` is async, hence the Promise return type.
   */
  duplicate(): Promise<RedisDriver>;

  /**
   * Establish the underlying connection. Resolves only when the client is fully
   * ready to accept commands (drivers abstract over each client's state machine —
   * ioredis has `wait → connecting → ready`, Bun has its own model).
   *
   * Idempotent: safe to call on an already-connected driver.
   */
  connect(): Promise<void>;

  /**
   * Close the underlying connection gracefully.
   *
   * The factory calls this only if it owns the client. When the user passed in
   * their own client instance, the factory leaves cleanup to them and never
   * calls `close()`.
   */
  close(): Promise<void>;

  /**
   * Force-close the underlying connection immediately, WITHOUT waiting for
   * pending commands. This is required for clients stuck in blocking commands
   * (`BZPOPMIN`, `XREAD BLOCK`, `SUBSCRIBE`) — a graceful `close()` would wait
   * for the blocking command to return naturally, adding up to its full timeout
   * to shutdown latency.
   *
   * Usage: the backend calls this on blocking-dequeue clients, subscribe
   * clients, and the job-waiter's XREAD client during shutdown. The main
   * client still uses `close()` for a clean QUIT.
   *
   * ioredis: `client.disconnect(false)` — closes socket immediately.
   * Bun: `client.close()` — Bun's close is already non-graceful.
   */
  disconnect(): Promise<void>;
}
