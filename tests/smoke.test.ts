import Redis from "ioredis";
import { describe, expect, it } from "vitest";

describe("smoke", () => {
  it("imports createTaskora factory from main entrypoint", async () => {
    const { createTaskora } = await import("../src/index.js");
    expect(typeof createTaskora).toBe("function");
  });

  it("imports redisAdapter from redis entrypoint", async () => {
    const { redisAdapter } = await import("../src/redis/index.js");
    expect(typeof redisAdapter).toBe("function");
  });

  it("connects to Redis via testcontainers and PINGs", async () => {
    const url = process.env.REDIS_URL;
    expect(url).toBeDefined();

    const redis = new Redis(url as string);
    try {
      const result = await redis.ping();
      expect(result).toBe("PONG");
    } finally {
      await redis.quit();
    }
  });
});
