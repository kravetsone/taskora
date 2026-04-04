import type { Redis, RedisOptions } from "ioredis";
import type { Taskora } from "../types.js";
import { RedisBackend } from "./backend.js";

export function redisAdapter(
  connection: string | RedisOptions | Redis,
  options?: { prefix?: string },
): Taskora.Adapter {
  return new RedisBackend(connection, options);
}
