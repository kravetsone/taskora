import type {
  PipelineBuilder,
  PipelineResult,
  RedisArg,
  RedisDriver,
  Unsubscribe,
  XReadResult,
} from "../driver.js";

// ─── Bun.RedisClient minimal interface ────────────────────────────────────────
//
// We declare a *local* shape for `Bun.RedisClient` instead of importing from
// the `bun` module. This avoids polluting the type graph for users on Node who
// will never load this file (they import `taskora/redis` or
// `taskora/redis/ioredis` instead). The shape covers only what BunDriver needs.
//
// At runtime, Bun.RedisClient is acquired via `import { RedisClient } from "bun"`
// — a runtime-conditional import inside `createBunDriver()` so the import
// itself never executes under Node.

/**
 * The subset of `Bun.RedisClient` that the driver consumes.
 *
 * Source of truth: https://bun.com/docs/runtime/redis
 */
export interface BunRedisClient {
  /**
   * Generic Redis command. Args MUST be strings — numbers and Buffers are
   * coerced inside the driver before reaching this method.
   *
   * Returns parsed RESP. Under RESP2 (which the driver forces via `HELLO 2`):
   *   - Integers → number
   *   - Bulk strings → string
   *   - Arrays → array
   *   - Null bulk → null
   */
  send(command: string, args: string[]): Promise<unknown>;

  /**
   * Subscribe to a channel. Subscription "takes over" the connection in
   * ioredis terms (Bun is more permissive but the driver doesn't rely on that).
   * Always call on a duplicated client.
   */
  subscribe(channel: string, listener: (message: string, channel: string) => void): Promise<void>;

  /** Unsubscribe a specific channel. */
  unsubscribe(channel: string): Promise<void>;

  /**
   * Open a sibling connection to the same server. Returns a Promise — the
   * duplicated client must be awaited before use. (verified empirically; the
   * docs example reads `const sub = await redis.duplicate()`).
   */
  duplicate(): Promise<BunRedisClient>;

  /** Establish the underlying connection. Idempotent. */
  connect(): Promise<void>;

  /** Close the underlying connection. */
  close(): void | Promise<void>;
}

// ─── BunDriver ────────────────────────────────────────────────────────────────

/**
 * `RedisDriver` implementation backed by `Bun.RedisClient`.
 *
 * The implementation strategy is "everything goes through `.send()`":
 *   - There are no native methods on `Bun.RedisClient` for Lua scripting,
 *     blocking commands, streams, or most hash/list/zset operations
 *   - But Bun's `.send()` is a generic RESP escape hatch that handles all of them
 *     correctly (verified by PoC against Bun 1.3.9)
 *   - Bun's auto-pipelining batches same-tick `.send()` calls into a single
 *     round-trip, so we get pipelining "for free" without manual transactions
 *
 * **Cluster / Sentinel are NOT supported** by Bun.RedisClient. Users on Cluster
 * or Sentinel must stay on `taskora/redis/ioredis`.
 *
 * The driver forces RESP2 mode at connect time (`HELLO 2`) to keep response
 * shapes identical to ioredis — most importantly, `HGETALL` returns a flat
 * `[k, v, k, v, ...]` array under RESP2, which we normalize to `Record<string,
 * string>` to match what call-sites expect.
 */
export class BunDriver implements RedisDriver {
  private readonly client: BunRedisClient;
  private connected = false;

  constructor(client: BunRedisClient) {
    this.client = client;
  }

  // Exposed for the factory.
  get raw(): BunRedisClient {
    return this.client;
  }

  async command(name: string, args: RedisArg[]): Promise<unknown> {
    const stringArgs = coerceArgs(args);
    const result = await this.client.send(name, stringArgs);

    // HGETALL normalization: Bun returns flat `[k, v, k, v, ...]` under RESP2.
    // ioredis transforms this into `Record<string, string>` automatically; we
    // do the same here so call-sites in backend.ts work unchanged.
    if (name.toLowerCase() === "hgetall" && Array.isArray(result)) {
      return flatArrayToRecord(result as string[]);
    }

    return result;
  }

  pipeline(): PipelineBuilder {
    return new BunPipelineBuilder(this.client);
  }

  async scriptLoad(source: string): Promise<string> {
    const sha = await this.client.send("SCRIPT", ["LOAD", source]);
    return String(sha);
  }

  async evalSha(
    sha: string,
    numKeys: number,
    args: RedisArg[],
    fallbackSource: string,
  ): Promise<unknown> {
    const stringArgs = coerceArgs(args);
    try {
      return await this.client.send("EVALSHA", [sha, String(numKeys), ...stringArgs]);
    } catch (err: unknown) {
      // PoC verified Bun's NOSCRIPT error message is exactly:
      //   "NOSCRIPT No matching script. Please use EVAL."
      // The same `includes("NOSCRIPT")` check that ioredis uses works here.
      if (err instanceof Error && err.message.includes("NOSCRIPT")) {
        const result = await this.client.send("EVAL", [
          fallbackSource,
          String(numKeys),
          ...stringArgs,
        ]);
        // Best-effort re-load for next call. SHA1 of identical source is
        // deterministic, so the SHA the backend has cached is still valid.
        await this.client.send("SCRIPT", ["LOAD", fallbackSource]).catch(() => undefined);
        return result;
      }
      throw err;
    }
  }

  async blockingZPopMin(
    key: string,
    timeoutSec: number,
  ): Promise<[string, string, string] | null> {
    // Verified in PoC: Bun's `.send("BZPOPMIN", ...)` actually blocks the JS
    // promise for the requested timeout, and parallel commands on duplicated
    // clients are NOT starved.
    const result = await this.client.send("BZPOPMIN", [key, String(timeoutSec)]);
    if (!result) return null;
    if (Array.isArray(result) && result.length === 3) {
      return [String(result[0]), String(result[1]), String(result[2])];
    }
    return null;
  }

  async blockingXRead(
    streams: string[],
    ids: string[],
    blockMs: number,
    count: number,
  ): Promise<XReadResult | null> {
    const args = [
      "BLOCK",
      String(blockMs),
      "COUNT",
      String(count),
      "STREAMS",
      ...streams,
      ...ids,
    ];
    const result = await this.client.send("XREAD", args);
    if (!result) return null;
    return result as XReadResult;
  }

  async subscribe(
    channel: string,
    handler: (message: string) => void,
  ): Promise<Unsubscribe> {
    await this.client.subscribe(channel, (message) => {
      handler(message);
    });
    return async () => {
      try {
        await this.client.unsubscribe(channel);
      } catch {
        // Already gone — fine.
      }
    };
  }

  async duplicate(): Promise<RedisDriver> {
    const dup = await this.client.duplicate();
    const driver = new BunDriver(dup);
    // Force RESP2 on the duplicated connection too. Bun's `duplicate()` may
    // return a client that's already connected; the HELLO call is idempotent.
    await driver.client.send("HELLO", ["2"]).catch(() => undefined);
    driver.connected = true;
    return driver;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect();
    // Force RESP2 so HGETALL returns flat-array (parsed by `flatArrayToRecord`)
    // and Lua return values pass through unmodified. Critical — see PoC notes.
    await this.client.send("HELLO", ["2"]);
    this.connected = true;
  }

  async close(): Promise<void> {
    this.connected = false;
    try {
      await this.client.close();
    } catch {
      // Already closed; fall through.
    }
  }
}

// ─── Pipeline emulation ───────────────────────────────────────────────────────

/**
 * Pipeline emulation built on `Promise.allSettled` over `.send()` calls.
 *
 * Bun's auto-pipelining coalesces same-tick `.send()` invocations into a single
 * round trip, so this is genuinely pipelined at the wire level — not a
 * sequence of N round trips.
 *
 * The result shape exactly matches ioredis's `[Error | null, value]` tuples:
 *   - Successful command → `[null, value]`
 *   - Failed command → `[Error, null]`
 *   - Per-command failures do NOT reject the whole pipeline (critical for
 *     `getTaskKeyStats` where individual `MEMORY USAGE` failures are tolerated).
 */
class BunPipelineBuilder implements PipelineBuilder {
  private readonly client: BunRedisClient;
  private readonly items: Array<{ name: string; args: string[] }> = [];

  constructor(client: BunRedisClient) {
    this.client = client;
  }

  add(command: string, args: RedisArg[]): this {
    this.items.push({ name: command, args: coerceArgs(args) });
    return this;
  }

  async exec(): Promise<PipelineResult> {
    if (this.items.length === 0) return [];
    const promises = this.items.map((i) => this.client.send(i.name, i.args));
    const settled = await Promise.allSettled(promises);
    return settled.map((r, idx): [Error | null, unknown] => {
      if (r.status === "fulfilled") {
        // HGETALL normalization in pipelines too (matches command() behavior).
        const item = this.items[idx];
        if (item.name.toLowerCase() === "hgetall" && Array.isArray(r.value)) {
          return [null, flatArrayToRecord(r.value as string[])];
        }
        return [null, r.value];
      }
      const err = r.reason instanceof Error ? r.reason : new Error(String(r.reason));
      return [err, null];
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Coerce taskora's `RedisArg` (string | number | Uint8Array) to the `string[]`
 * shape Bun.RedisClient.send() requires.
 *
 * Uint8Array is allowed by the type but not currently used by any taskora
 * call-site; pass-through here is for future-proofing. If a binary arg ever
 * does flow through, Bun's `.send()` will reject — at which point we can
 * encode (base64? raw?) here.
 */
function coerceArgs(args: RedisArg[]): string[] {
  const out: string[] = new Array(args.length);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a === "string") out[i] = a;
    else if (typeof a === "number") out[i] = String(a);
    else out[i] = Buffer.from(a).toString();
  }
  return out;
}

/**
 * Convert RESP2 `HGETALL` flat-array `[k, v, k, v, ...]` into the
 * `Record<string, string>` shape backend.ts call-sites expect.
 */
function flatArrayToRecord(flat: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) {
    out[flat[i]] = flat[i + 1];
  }
  return out;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Construct a `BunDriver` from any of: a connection URL string, a Bun
 * `RedisOptions` config object, or a pre-built `Bun.RedisClient` instance.
 *
 * Uses the global `Bun.RedisClient` constructor (Bun ships its Redis client
 * as a runtime built-in, available as `globalThis.Bun.RedisClient`). Throws
 * a clear error if called outside the Bun runtime.
 *
 * Synchronous on purpose — keeps the factory API consistent with the ioredis
 * factory so users don't have to remember which one to await.
 */
export function createBunDriver(
  connection: string | Record<string, unknown> | BunRedisClient,
): { driver: BunDriver; ownsClient: boolean } {
  // Detect a pre-built client by duck-typing on the methods we care about.
  // We can't `instanceof` against Bun.RedisClient without importing the type.
  if (
    typeof connection === "object" &&
    connection !== null &&
    typeof (connection as BunRedisClient).send === "function" &&
    typeof (connection as BunRedisClient).subscribe === "function"
  ) {
    return { driver: new BunDriver(connection as BunRedisClient), ownsClient: false };
  }

  // Pull the constructor from the global Bun namespace at call time. This
  // avoids any module-level reference to "bun" so Node bundlers don't choke
  // on the import.
  const bunGlobal = (globalThis as { Bun?: { RedisClient: new (url?: string, opts?: unknown) => BunRedisClient } }).Bun;
  if (!bunGlobal || typeof bunGlobal.RedisClient !== "function") {
    throw new Error(
      "taskora/redis/bun requires the Bun runtime (https://bun.sh). " +
        "On Node.js, use taskora/redis (ioredis driver) instead.",
    );
  }
  const RedisClientCtor = bunGlobal.RedisClient;

  let client: BunRedisClient;
  if (typeof connection === "string") {
    client = new RedisClientCtor(connection);
  } else {
    // For options-form, Bun's constructor accepts (url?, options?). When the
    // user passes only options, we let the URL fall through to Bun's default
    // (REDIS_URL env var or "redis://localhost:6379").
    client = new RedisClientCtor(undefined, connection);
  }
  return { driver: new BunDriver(client), ownsClient: true };
}
