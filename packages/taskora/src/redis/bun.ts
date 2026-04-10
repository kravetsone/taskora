import type { Taskora } from "../types.js";
import { RedisBackend } from "./backend.js";
import { type BunRedisClient, createBunDriver } from "./drivers/bun.js";

/**
 * Construct a taskora `Adapter` backed by Bun's built-in `Bun.RedisClient`.
 *
 * Accepts a connection URL, an options object, or a pre-built
 * `Bun.RedisClient` instance. When a client is passed in, the adapter will
 * not close it on disconnect — that responsibility stays with the caller.
 *
 * **This driver only runs under the Bun runtime.** Calling it from Node will
 * throw a clear error. For Node, use `taskora/redis/ioredis` (or the canonical
 * `taskora/redis`, which re-exports the ioredis driver).
 *
 * **Limitations vs. the ioredis driver:**
 *  - **No Redis Cluster** — `Bun.RedisClient` does not support cluster mode.
 *    Taskora's keys use `{task}` hash tags so the scripts are *cluster-safe*,
 *    but Bun cannot route commands across cluster nodes. Cluster users must
 *    stay on `taskora/redis/ioredis`.
 *  - **No Redis Sentinel** — same constraint.
 *  - **RESP2 forced** — the driver issues `HELLO 2` at connect time so
 *    response shapes (most notably `HGETALL`) match what taskora expects.
 *
 * Internally, the driver routes most commands through Bun's generic
 * `.send(cmd, args)` escape hatch. Bun's auto-pipelining batches same-tick
 * `.send` calls into a single round trip, so pipeline performance is
 * comparable to ioredis without requiring an explicit transaction API.
 */
export function redisAdapter(
  connection: string | Record<string, unknown> | BunRedisClient,
  options?: { prefix?: string },
): Taskora.Adapter {
  const { driver, ownsClient } = createBunDriver(connection);
  return new RedisBackend({ driver, ownsDriver: ownsClient, prefix: options?.prefix });
}

export type { BunRedisClient } from "./drivers/bun.js";
