import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTaskora } from "../../src/index.js";
import { redisAdapter } from "../create-adapter.js";
import { url, waitFor } from "../helpers.js";

let redis: Redis;

beforeEach(() => {
  redis = new Redis(url());
});

afterEach(async () => {
  await redis.flushdb();
  await redis.quit();
});

// ── TTL / Expiration ────────────────────────────────────────────────

describe("TTL / expiration", () => {
  it("expired job is not processed (task-level TTL)", async () => {
    const processed: string[] = [];

    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("ttl-task", {
      ttl: { max: 100 },
      handler: async (data: { id: string }) => {
        processed.push(data.id);
      },
    });

    const h = task.dispatch({ id: "expired-job" });
    await h; // ensure enqueued

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 200));

    await app.start();

    // Give worker time to try processing (it should skip the expired job)
    await new Promise((r) => setTimeout(r, 500));

    expect(processed).toEqual([]);

    // Check via inspector — expired sorted set should have 1 job
    const stats = await app.inspect().stats({ task: "ttl-task" });
    expect(stats.expired).toBe(1);
    expect(stats.waiting).toBe(0);

    await app.close();
  });

  it("dispatch-level TTL overrides task default", async () => {
    const processed: string[] = [];

    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("ttl-override", {
      ttl: { max: "10s" }, // long task-level TTL
      handler: async (data: { id: string }) => {
        processed.push(data.id);
      },
    });

    // Dispatch with very short TTL override
    const h = task.dispatch({ id: "short-ttl" }, { ttl: 100 });
    await h;

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 200));

    await app.start();
    await new Promise((r) => setTimeout(r, 500));

    expect(processed).toEqual([]);

    await app.close();
  });

  it("non-expired job is processed normally", async () => {
    const processed: string[] = [];

    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("ttl-ok", {
      ttl: { max: "10s" },
      handler: async (data: { id: string }) => {
        processed.push(data.id);
      },
    });

    const h = task.dispatch({ id: "fresh-job" });
    await h;

    await app.start();
    await waitFor(() => processed.length === 1, 5000);
    expect(processed).toEqual(["fresh-job"]);

    await app.close();
  });

  it("onExpire: discard removes job completely", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("ttl-discard", {
      ttl: { max: 100, onExpire: "discard" },
      handler: async () => {},
    });

    const h = task.dispatch({ id: "discard-me" });
    await h;

    await new Promise((r) => setTimeout(r, 200));

    await app.start();
    await new Promise((r) => setTimeout(r, 500));

    // Job hash should be deleted (discarded)
    const exists = await redis.exists("taskora:{ttl-discard}:discard-me");
    expect(exists).toBe(0);

    // expired set should be empty (discarded, not moved)
    const expiredCount = await redis.zcard("taskora:{ttl-discard}:expired");
    expect(expiredCount).toBe(0);

    await app.close();
  });

  it("delayed job with TTL — expires before promotion", async () => {
    const processed: string[] = [];

    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("ttl-delayed", {
      ttl: { max: 100 },
      handler: async (data: { id: string }) => {
        processed.push(data.id);
      },
    });

    // Dispatch with delay longer than TTL
    await task.dispatch({ id: "delayed-expired" }, { delay: 500 });

    await app.start();

    // Wait for delay + promotion + processing
    await new Promise((r) => setTimeout(r, 1500));

    expect(processed).toEqual([]);

    const stats = await app.inspect().stats({ task: "ttl-delayed" });
    expect(stats.expired).toBe(1);
    expect(stats.waiting).toBe(0);

    await app.close();
  });

  it("TTL via inspector — expired jobs appear in stats", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("ttl-stats", {
      ttl: { max: 100 },
      handler: async () => {},
    });

    const h = task.dispatch({ x: 1 });
    await h;

    await new Promise((r) => setTimeout(r, 200));

    await app.start();
    await new Promise((r) => setTimeout(r, 500));

    const stats = await app.inspect().stats({ task: "ttl-stats" });
    expect(stats.expired).toBe(1);
    expect(stats.waiting).toBe(0);

    await app.close();
  });
});

// ── Singleton ───────────────────────────────────────────────────────

describe("singleton", () => {
  it("only one job active at a time — second waits", async () => {
    const order: string[] = [];
    let resolveFirst: (() => void) | null = null;
    const firstStarted = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("singleton-test", {
      singleton: true,
      concurrency: 5, // high concurrency — singleton should still limit to 1
      handler: async (data: { id: string }) => {
        order.push(`start:${data.id}`);
        if (data.id === "first") {
          resolveFirst?.();
          await new Promise((r) => setTimeout(r, 1500));
        }
        order.push(`end:${data.id}`);
      },
    });

    // Await dispatches sequentially to guarantee FIFO order
    await task.dispatch({ id: "first" });
    await task.dispatch({ id: "second" });

    await app.start();

    // Wait for first to start
    await firstStarted;
    // At this point, only "first" should be active
    await new Promise((r) => setTimeout(r, 200));
    expect(order).toEqual(["start:first"]);

    // Wait for both to complete
    await waitFor(() => order.length === 4, 10000);

    // Second should have started only after first ended
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);

    await app.close();
  });

  it("singleton — non-singleton task processes concurrently", async () => {
    const active: string[] = [];
    let maxConcurrent = 0;

    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("non-singleton", {
      concurrency: 5,
      handler: async (data: { id: string }) => {
        active.push(data.id);
        maxConcurrent = Math.max(maxConcurrent, active.length);
        await new Promise((r) => setTimeout(r, 300));
        active.splice(active.indexOf(data.id), 1);
      },
    });

    for (let i = 0; i < 3; i++) {
      await task.dispatch({ id: `job-${i}` });
    }

    await app.start();
    await waitFor(() => maxConcurrent > 1, 5000);
    expect(maxConcurrent).toBeGreaterThan(1);

    await app.close({ timeout: 3000 });
  });
});

// ── Concurrency per key ─────────────────────────────────────────────

describe("concurrency per key", () => {
  it("respects per-key limit — max 1 per key", async () => {
    const order: string[] = [];
    const resolvers = new Map<string, () => void>();

    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("conc-key", {
      concurrency: 10,
      concurrencyLimit: 1,
      handler: async (data: { id: string; key: string }) => {
        order.push(`start:${data.id}`);
        await new Promise<void>((r) => {
          resolvers.set(data.id, r);
        });
        order.push(`end:${data.id}`);
      },
    });

    // Await dispatches sequentially to guarantee FIFO order
    await task.dispatch({ id: "a1", key: "org-a" }, { concurrencyKey: "org-a" });
    await task.dispatch({ id: "a2", key: "org-a" }, { concurrencyKey: "org-a" });
    await task.dispatch({ id: "b1", key: "org-b" }, { concurrencyKey: "org-b" });

    await app.start();

    // Wait for a1 and b1 to start (a2 should be blocked)
    await waitFor(() => order.includes("start:a1") && order.includes("start:b1"), 5000);
    await new Promise((r) => setTimeout(r, 300));

    // a2 should NOT have started yet
    expect(order).not.toContain("start:a2");

    // Complete a1 — a2 should then start
    resolvers.get("a1")?.();
    await waitFor(() => order.includes("start:a2"), 5000);

    // Complete remaining
    resolvers.get("b1")?.();
    resolvers.get("a2")?.();

    await waitFor(() => order.filter((e) => e.startsWith("end:")).length === 3, 5000);

    await app.close();
  });

  it("dispatch-level concurrencyLimit overrides task default", async () => {
    const active = new Map<string, number>();
    let maxPerKey = 0;

    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("conc-override", {
      concurrency: 10,
      concurrencyLimit: 1, // task default
      handler: async (data: { id: string }) => {
        const cur = (active.get("k") ?? 0) + 1;
        active.set("k", cur);
        maxPerKey = Math.max(maxPerKey, cur);
        await new Promise((r) => setTimeout(r, 500));
        active.set("k", (active.get("k") ?? 1) - 1);
      },
    });

    // Dispatch with higher limit override
    for (let i = 0; i < 4; i++) {
      await task.dispatch(
        { id: `j${i}` },
        {
          concurrencyKey: "k",
          concurrencyLimit: 3,
        },
      );
    }

    await app.start();
    await waitFor(() => maxPerKey > 1, 5000);
    expect(maxPerKey).toBeLessThanOrEqual(3);

    await app.close({ timeout: 3000 });
  });

  it("concurrency counter released on job failure", async () => {
    let attempts = 0;

    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("conc-fail", {
      concurrency: 5,
      concurrencyLimit: 1,
      handler: async (data: { id: string }) => {
        attempts++;
        if (data.id === "fail-job") {
          throw new Error("intentional failure");
        }
        // Second job should run after first fails
        await new Promise((r) => setTimeout(r, 100));
      },
    });

    await task.dispatch({ id: "fail-job" }, { concurrencyKey: "k" });
    await task.dispatch({ id: "ok-job" }, { concurrencyKey: "k" });

    await app.start();

    // Both should eventually be processed (fail releases the slot)
    await waitFor(() => attempts >= 2, 5000);

    await app.close();
  });

  it("different keys are independent", async () => {
    const startTimes: Record<string, number> = {};

    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("conc-independent", {
      concurrency: 10,
      concurrencyLimit: 1,
      handler: async (data: { id: string }) => {
        startTimes[data.id] = Date.now();
        await new Promise((r) => setTimeout(r, 500));
      },
    });

    await task.dispatch({ id: "a" }, { concurrencyKey: "key-a" });
    await task.dispatch({ id: "b" }, { concurrencyKey: "key-b" });

    await app.start();

    await waitFor(() => Object.keys(startTimes).length === 2, 5000);

    // Both should have started near-simultaneously (different keys)
    const diff = Math.abs(startTimes.a - startTimes.b);
    expect(diff).toBeLessThan(500);

    await app.close({ timeout: 3000 });
  });
});
