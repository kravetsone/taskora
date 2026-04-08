import type { Redis, RedisOptions } from "ioredis";
import type { Taskora } from "../types.js";
import { RedisBackend } from "./backend.js";
import { createIoredisDriver } from "./drivers/ioredis.js";

/**
 * Construct a taskora `Adapter` backed by ioredis.
 *
 * Accepts a connection URL, an `RedisOptions` config object, or a pre-built
 * `Redis` instance. When a client instance is passed in, the adapter will not
 * close it on disconnect — that responsibility stays with the caller.
 *
 * This is the recommended driver for production use today: it has the most
 * complete feature support (Cluster, Sentinel, RESP2/RESP3), the largest
 * battle-tested user base, and supports every Redis command taskora needs
 * via dedicated methods rather than the generic `.send()` escape hatch.
 *
 * For Bun-only deployments where the ioredis peer dependency is undesirable,
 * see `taskora/redis/bun`.
 */
export function redisAdapter(
  connection: string | RedisOptions | Redis,
  options?: { prefix?: string },
): Taskora.Adapter {
  const { driver, ownsClient } = createIoredisDriver(connection);
  return new RedisBackend({ driver, ownsDriver: ownsClient, prefix: options?.prefix });
}
