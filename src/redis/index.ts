import type { Redis, RedisOptions } from "ioredis";
import type { Taskora } from "../types.js";

export function redisAdapter(_connection: string | RedisOptions | Redis): Taskora.Adapter {
  return {
    connect: async () => {
      throw new Error("Not implemented: Redis connect comes in Phase 1");
    },
    disconnect: async () => {
      throw new Error("Not implemented: Redis disconnect comes in Phase 1");
    },
  };
}
