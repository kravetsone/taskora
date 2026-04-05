import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { taskora } from "../../src/index.js";
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

// ── Version stamping ──────────────────────────────────────────────────

describe("version stamping", () => {
  it("dispatch stamps _v = task.version in job hash", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("versioned", {
      version: 3,
      input: z.object({ x: z.number() }),
      handler: async (data) => data,
    });

    const jobId = await task.dispatch({ x: 1 });
    const storedVersion = await redis.hget(`taskora:{versioned}:${jobId}`, "_v");
    expect(storedVersion).toBe("3");

    await app.close();
  });

  it("unversioned task dispatches with _v = 1", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("no-version", async (data: { x: number }) => data);

    const jobId = await task.dispatch({ x: 1 });
    const storedVersion = await redis.hget(`taskora:{no-version}:${jobId}`, "_v");
    expect(storedVersion).toBe("1");

    await app.close();
  });
});

// ── Migration processing ──────────────────────────────────────────────

describe("migration — old version job processes correctly", () => {
  it("tuple migrate: v1 job runs through migration chain", async () => {
    const processed: unknown[] = [];

    // Pre-enqueue a v1 job by hand (simulating old worker)
    const jobId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await redis.hset(
      `taskora:{email}:${jobId}`,
      "ts",
      String(Date.now()),
      "_v",
      "1",
      "attempt",
      "1",
      "state",
      "waiting",
      "priority",
      "0",
      "maxAttempts",
      "1",
    );
    await redis.set(`taskora:{email}:${jobId}:data`, JSON.stringify({ to: "alice@test.com" }));
    await redis.lpush("taskora:{email}:wait", jobId);
    // Wake marker
    await redis.zadd("taskora:{email}:marker", "0", "0");

    const app = taskora({ adapter: redisAdapter(url()) });

    app.task("email", {
      input: z.object({
        to: z.string(),
        html: z.boolean().default(false),
        body: z.object({ text: z.string() }),
      }),
      migrate: [
        // v1→v2: add html (schema default handles it, but body needs migration)
        (data) => ({ ...(data as any), body: { text: "default body" } }),
      ],
      // version = 1 + 1 = 2
      handler: async (data) => {
        processed.push(data);
        return null;
      },
    });

    await app.start();

    await waitFor(() => processed.length === 1);

    // v1 job should have been migrated to v2 schema:
    // - body: added by migration function
    // - html: added by schema .default(false)
    expect(processed[0]).toEqual({
      to: "alice@test.com",
      html: false,
      body: { text: "default body" },
    });

    await app.close();
  });

  it("record migrate: sparse migration with gaps handled by schema defaults", async () => {
    const processed: unknown[] = [];

    // Pre-enqueue a v2 job
    const jobId = "11111111-2222-3333-4444-555555555555";
    await redis.hset(
      `taskora:{sparse}:${jobId}`,
      "ts",
      String(Date.now()),
      "_v",
      "2",
      "attempt",
      "1",
      "state",
      "waiting",
      "priority",
      "0",
      "maxAttempts",
      "1",
    );
    await redis.set(`taskora:{sparse}:${jobId}:data`, JSON.stringify({ name: "test" }));
    await redis.lpush("taskora:{sparse}:wait", jobId);
    await redis.zadd("taskora:{sparse}:marker", "0", "0");

    const app = taskora({ adapter: redisAdapter(url()) });

    app.task("sparse", {
      version: 4,
      input: z.object({
        name: z.string(),
        active: z.boolean().default(true), // v2→v3 gap: schema default
        role: z.string(), // v3→v4 breaking: needs migration
      }),
      migrate: {
        // Only v3→v4 needs a function
        3: (data) => ({ ...(data as any), role: "user" }),
      },
      handler: async (data) => {
        processed.push(data);
        return null;
      },
    });

    await app.start();

    await waitFor(() => processed.length === 1);

    // v2→v3: gap → schema .default(true) for active
    // v3→v4: migration adds role
    expect(processed[0]).toEqual({
      name: "test",
      active: true,
      role: "user",
    });

    await app.close();
  });
});

// ── Future version nack ───────────────────────────────────────────────

describe("migration — future version nack", () => {
  it("nacks a job with version higher than task version (never processed)", async () => {
    // Pre-enqueue a v5 job — this worker only knows v3
    const jobId = "aaaaaaaa-1111-2222-3333-ffffffffffff";
    await redis.hset(
      `taskora:{future}:${jobId}`,
      "ts",
      String(Date.now()),
      "_v",
      "5",
      "attempt",
      "1",
      "state",
      "waiting",
      "priority",
      "0",
      "maxAttempts",
      "1",
    );
    await redis.set(`taskora:{future}:${jobId}:data`, JSON.stringify({ x: 1 }));
    await redis.lpush("taskora:{future}:wait", jobId);
    await redis.zadd("taskora:{future}:marker", "0", "0");

    let handlerCalled = false;

    const app = taskora({ adapter: redisAdapter(url()) });

    app.task("future", {
      version: 3,
      input: z.object({ x: z.number() }),
      handler: async (data) => {
        handlerCalled = true;
        return data;
      },
    });

    await app.start();

    // Give worker time to dequeue and nack several times
    await new Promise((r) => setTimeout(r, 500));
    await app.close();

    // Handler should never have been called for a future-version job
    expect(handlerCalled).toBe(false);

    // Job should NOT be in completed or failed — it was nacked, not processed
    const failedCount = await redis.zcard("taskora:{future}:failed");
    expect(failedCount).toBe(0);

    const completedCount = await redis.zcard("taskora:{future}:completed");
    expect(completedCount).toBe(0);
  });
});

// ── Expired version fail ──────────────────────────────────────────────

describe("migration — expired version fail", () => {
  it("fails a job below since (migration no longer available)", async () => {
    // Pre-enqueue a v1 job — task has since: 3
    const jobId = "bbbbbbbb-1111-2222-3333-ffffffffffff";
    await redis.hset(
      `taskora:{expired}:${jobId}`,
      "ts",
      String(Date.now()),
      "_v",
      "1",
      "attempt",
      "1",
      "state",
      "waiting",
      "priority",
      "0",
      "maxAttempts",
      "1",
    );
    await redis.set(`taskora:{expired}:${jobId}:data`, JSON.stringify({ x: 1 }));
    await redis.lpush("taskora:{expired}:wait", jobId);
    await redis.zadd("taskora:{expired}:marker", "0", "0");

    const app = taskora({ adapter: redisAdapter(url()) });

    app.task("expired", {
      version: 5,
      since: 3,
      input: z.object({ x: z.number(), extra: z.string() }),
      migrate: {
        3: (data) => ({ ...(data as any), extra: "added" }),
      },
      handler: async (data) => {
        throw new Error("Should not be called");
      },
    });

    await app.start();

    await waitFor(async () => {
      const failedCount = await redis.zcard("taskora:{expired}:failed");
      return failedCount === 1;
    });

    const error = await redis.hget(`taskora:{expired}:${jobId}`, "error");
    expect(error).toContain("version 1");
    expect(error).toContain("minimum supported version 3");

    await app.close();
  });
});

// ── inspect().migrations() ────────────────────────────────────────────

describe("inspect().migrations()", () => {
  it("returns version distribution across queue states", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("inspect-test", {
      version: 3,
      input: z.object({ x: z.number() }),
      handler: async (data) => data,
    });

    // Enqueue jobs at different versions by hand
    for (const [id, v, list] of [
      ["aaa", "1", "wait"],
      ["bbb", "1", "wait"],
      ["ccc", "2", "wait"],
      ["ddd", "3", "wait"],
      ["eee", "3", "wait"],
      ["fff", "3", "wait"],
    ] as const) {
      const jobId = `${id}aaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;
      await redis.hset(
        `taskora:{inspect-test}:${jobId}`,
        "ts",
        String(Date.now()),
        "_v",
        v,
        "attempt",
        "1",
        "state",
        list === "wait" ? "waiting" : "delayed",
        "priority",
        "0",
        "maxAttempts",
        "1",
      );
      await redis.set(`taskora:{inspect-test}:${jobId}:data`, JSON.stringify({ x: 1 }));
      if (list === "wait") {
        await redis.lpush("taskora:{inspect-test}:wait", jobId);
      }
    }

    // Add a delayed job
    const delayedId = "delaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await redis.hset(
      `taskora:{inspect-test}:${delayedId}`,
      "ts",
      String(Date.now()),
      "_v",
      "2",
      "attempt",
      "1",
      "state",
      "delayed",
      "priority",
      "0",
      "maxAttempts",
      "1",
    );
    await redis.set(`taskora:{inspect-test}:${delayedId}:data`, JSON.stringify({ x: 1 }));
    await redis.zadd("taskora:{inspect-test}:delayed", String(Date.now() + 60000), delayedId);

    await app.ensureConnected();
    const status = await app.inspect().migrations("inspect-test");

    expect(status.version).toBe(3);
    expect(status.since).toBe(1);
    expect(status.migrations).toBe(0); // no migrate defined

    // Queue (waiting + active)
    expect(status.queue.byVersion[1]).toBe(2);
    expect(status.queue.byVersion[2]).toBe(1);
    expect(status.queue.byVersion[3]).toBe(3);
    expect(status.queue.oldest).toBe(1);

    // Delayed
    expect(status.delayed.byVersion[2]).toBe(1);
    expect(status.delayed.oldest).toBe(2);

    // canBumpSince = lowest version across all jobs
    expect(status.canBumpSince).toBe(1);

    await app.close();
  });

  it("throws for unknown task name", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });
    await app.ensureConnected();

    await expect(app.inspect().migrations("nonexistent")).rejects.toThrow(
      'Task "nonexistent" not found',
    );

    await app.close();
  });

  it("empty queue returns task version as canBumpSince", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    app.task("empty-queue", {
      version: 5,
      since: 2,
      input: z.object({ x: z.number() }),
      handler: async (data) => data,
    });

    await app.ensureConnected();
    const status = await app.inspect().migrations("empty-queue");

    expect(status.version).toBe(5);
    expect(status.since).toBe(2);
    expect(status.queue.oldest).toBeNull();
    expect(status.delayed.oldest).toBeNull();
    expect(status.canBumpSince).toBe(5);

    await app.close();
  });
});
