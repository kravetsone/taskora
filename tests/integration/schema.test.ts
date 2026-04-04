import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ValidationError } from "../../src/errors.js";
import { taskora } from "../../src/index.js";
import { redisAdapter } from "../../src/redis/index.js";

let redis: Redis;

function url() {
  const u = process.env.REDIS_URL;
  if (!u) throw new Error("REDIS_URL not set");
  return u;
}

beforeEach(() => {
  redis = new Redis(url());
});

afterEach(async () => {
  await redis.flushdb();
  await redis.quit();
});

async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 10_000, interval = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("schema validation — dispatch", () => {
  it("rejects invalid input before enqueue", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("validated", {
      input: z.object({ email: z.string().email() }),
      handler: async (data) => null,
    });

    await expect(task.dispatch({ email: "not-an-email" } as any)).rejects.toThrow(ValidationError);

    // Nothing should be enqueued
    const waitCount = await redis.llen("taskora:{validated}:wait");
    expect(waitCount).toBe(0);

    await app.close();
  });

  it("allows valid input through", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("validated-ok", {
      input: z.object({ email: z.string().email() }),
      handler: async (data) => null,
    });

    const id = await task.dispatch({ email: "alice@example.com" });
    expect(id).toBeDefined();

    await app.close();
  });
});

describe("schema validation — worker output", () => {
  it("fails job when handler returns invalid output", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("bad-output", {
      output: z.object({ id: z.string().uuid() }),
      handler: async () => {
        return { id: "not-a-uuid" } as any;
      },
    });

    await task.dispatch({});
    await app.start();

    await waitFor(async () => {
      const failedCount = await redis.zcard("taskora:{bad-output}:failed");
      return failedCount === 1;
    });

    const error = await redis.hget("taskora:{bad-output}:1", "error");
    expect(error).toContain("Validation failed");

    await app.close();
  });

  it("acks job when handler returns valid output", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("good-output", {
      input: z.object({ name: z.string() }),
      output: z.object({ greeting: z.string() }),
      handler: async (data) => {
        return { greeting: `Hello, ${data.name}!` };
      },
    });

    await task.dispatch({ name: "Alice" });
    await app.start();

    await waitFor(async () => {
      const completedCount = await redis.zcard("taskora:{good-output}:completed");
      return completedCount === 1;
    });

    const result = await redis.get("taskora:{good-output}:1:result");
    expect(JSON.parse(result as string)).toEqual({ greeting: "Hello, Alice!" });

    await app.close();
  });
});
