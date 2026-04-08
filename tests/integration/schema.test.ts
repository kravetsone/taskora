import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as z from "zod";
import { ValidationError } from "../../src/errors.js";
import { createTaskora } from "../../src/index.js";
import { redisAdapter } from "../../src/redis/index.js";
import { url, waitFor } from "../helpers.js";

let redis: Redis;

beforeEach(() => {
  redis = new Redis(url());
});

afterEach(async () => {
  await redis.flushdb();
  await redis.quit();
});

describe("schema validation — dispatch", () => {
  it("rejects invalid input before enqueue", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });

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
    const app = createTaskora({ adapter: redisAdapter(url()) });

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
    const app = createTaskora({ adapter: redisAdapter(url()) });

    const task = app.task("bad-output", {
      output: z.object({ id: z.string().uuid() }),
      handler: async () => {
        return { id: "not-a-uuid" } as any;
      },
    });

    const handle = task.dispatch({});
    const jobId = await handle;
    await app.start();

    await waitFor(async () => {
      const failedCount = await redis.zcard("taskora:{bad-output}:failed");
      return failedCount === 1;
    });

    const error = await redis.hget(`taskora:{bad-output}:${jobId}`, "error");
    expect(error).toContain("Validation failed");

    await app.close();
  });

  it("acks job when handler returns valid output", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });

    const task = app.task("good-output", {
      input: z.object({ name: z.string() }),
      output: z.object({ greeting: z.string() }),
      handler: async (data) => {
        return { greeting: `Hello, ${data.name}!` };
      },
    });

    const handle = task.dispatch({ name: "Alice" });
    const jobId = await handle;
    await app.start();

    await waitFor(async () => {
      const completedCount = await redis.zcard("taskora:{good-output}:completed");
      return completedCount === 1;
    });

    const result = await redis.get(`taskora:{good-output}:${jobId}:result`);
    expect(JSON.parse(result as string)).toEqual({ greeting: "Hello, Alice!" });

    await app.close();
  });
});
