import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTaskora } from "../../src/index.js";
import type { Taskora } from "../../src/types.js";
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

// ── Stall detection ──────────────────────────────────────────────

describe("stall detection", () => {
  it("recovers a stalled job back to wait", async () => {
    // 1. Dispatch a job and start a worker that hangs forever (simulating a crash)
    const app1 = createTaskora({ adapter: redisAdapter(url()) });
    let started = false;

    app1.task("stall-test", {
      stall: { interval: 100, maxCount: 1 },
      handler: async (_data: unknown, ctx) => {
        started = true;
        // Simulate a crash: hang until aborted, never ack
        await new Promise((resolve) => {
          ctx.signal.addEventListener("abort", resolve);
        });
        return null;
      },
    });

    const task1 = app1.task("stall-dispatch", async () => null);
    // We need to use the same task name for dispatch and processing
    // Let's use a single app approach instead

    await app1.close();

    // Better approach: use adapter directly to simulate crash scenario
    const adapter = redisAdapter(url());
    const app = createTaskora({ adapter });

    let processedCount = 0;

    const task = app.task("stall-recover", {
      // Very short stall interval for testing
      stall: { interval: 200, maxCount: 1 },
      handler: async () => {
        processedCount++;
        return null;
      },
    });

    // Dispatch a job
    const handle = task.dispatch({ msg: "test" });
    await handle;

    // Manually simulate a crashed worker:
    // Move job from wait → active without a lock (or let the lock expire)
    await adapter.connect();

    const jobId = handle.id;
    // Move to active list (simulating dequeue)
    await redis.lmove(
      "taskora:{stall-recover}:wait",
      "taskora:{stall-recover}:active",
      "RIGHT",
      "LEFT",
    );
    await redis.hset(`taskora:{stall-recover}:${jobId}`, "state", "active");
    // No lock set → will be detected as stalled

    // Start the real worker — the stall check should recover the job
    await app.start();

    await waitFor(() => processedCount === 1);
    expect(processedCount).toBe(1);

    // Verify job completed
    const state = await redis.hget(`taskora:{stall-recover}:${jobId}`, "state");
    expect(state).toBe("completed");

    await app.close();
  });

  it("fails a job after exceeding maxStalledCount", async () => {
    const adapter = redisAdapter(url());
    const app = createTaskora({ adapter });

    const task = app.task("stall-fail", {
      stall: { interval: 200, maxCount: 1 },
      handler: async () => {
        // This handler should never actually run for the stalled job
        // because we'll stall it twice before the worker picks it up
        return null;
      },
    });

    // Dispatch a job
    const handle = task.dispatch({ msg: "test" });
    await handle;
    const jobId = handle.id;

    await adapter.connect();

    // Simulate first stall: move to active, no lock, seed stalled set
    await redis.lmove("taskora:{stall-fail}:wait", "taskora:{stall-fail}:active", "RIGHT", "LEFT");
    await redis.hset(`taskora:{stall-fail}:${jobId}`, "state", "active");
    await redis.sadd("taskora:{stall-fail}:stalled", jobId);

    // Run stall check 1 → should recover (stalledCount becomes 1, maxCount is 1)
    const result1 = await adapter.stalledCheck("stall-fail", 1);
    expect(result1.recovered).toEqual([jobId]);
    expect(result1.failed).toEqual([]);

    // Verify job is back in wait
    const stateAfter1 = await redis.hget(`taskora:{stall-fail}:${jobId}`, "state");
    expect(stateAfter1).toBe("waiting");

    // Simulate second stall: move to active again, no lock
    await redis.lmove("taskora:{stall-fail}:wait", "taskora:{stall-fail}:active", "RIGHT", "LEFT");
    await redis.hset(`taskora:{stall-fail}:${jobId}`, "state", "active");

    // Seed the stalled set (Phase 2 of previous check already did this,
    // but we moved the job manually, so re-seed)
    await redis.sadd("taskora:{stall-fail}:stalled", jobId);

    // Run stall check 2 → should fail (stalledCount becomes 2, > maxCount 1)
    const result2 = await adapter.stalledCheck("stall-fail", 1);
    expect(result2.recovered).toEqual([]);
    expect(result2.failed).toEqual([jobId]);

    // Verify job is in failed state
    const stateAfter2 = await redis.hget(`taskora:{stall-fail}:${jobId}`, "state");
    expect(stateAfter2).toBe("failed");

    const error = await redis.hget(`taskora:{stall-fail}:${jobId}`, "error");
    expect(error).toContain("stalled");

    const stalledCount = await redis.hget(`taskora:{stall-fail}:${jobId}`, "stalledCount");
    expect(stalledCount).toBe("2");

    await app.close();
  });

  it("healthy worker with heartbeat is never marked stalled", async () => {
    const adapter = redisAdapter(url());
    const app = createTaskora({ adapter });

    let jobFinished = false;

    const task = app.task("stall-healthy", {
      stall: { interval: 150, maxCount: 1 },
      handler: async (_data: unknown, ctx) => {
        // Simulate long-running work with heartbeats
        for (let i = 0; i < 5; i++) {
          ctx.heartbeat();
          await new Promise((r) => setTimeout(r, 100));
        }
        jobFinished = true;
        return { ok: true };
      },
    });

    const handle = task.dispatch({ msg: "heartbeat-test" });
    await handle;

    await app.start();

    await waitFor(async () => {
      const s = await redis.hget(`taskora:{stall-healthy}:${handle.id}`, "state");
      return s === "completed";
    }, 5_000);

    expect(jobFinished).toBe(true);

    // stalledCount should not exist (never stalled)
    const stalledCount = await redis.hget(`taskora:{stall-healthy}:${handle.id}`, "stalledCount");
    expect(stalledCount).toBeNull();

    await app.close();
  });

  it("emits stalled event on task and app", async () => {
    const adapter = redisAdapter(url());
    const app = createTaskora({ adapter });

    const stalledEvents: Taskora.StalledEvent[] = [];
    const appStalledEvents: Array<Taskora.StalledEvent & { task: string }> = [];

    const task = app.task("stall-events", {
      stall: { interval: 200, maxCount: 2 },
      handler: async () => null,
    });

    task.on("stalled", (event) => {
      stalledEvents.push(event);
    });

    app.on("task:stalled", (event) => {
      appStalledEvents.push(event);
    });

    // Dispatch and simulate a stall
    const handle = task.dispatch({ msg: "event-test" });
    await handle;
    const jobId = handle.id;

    await adapter.connect();

    // Move to active without lock
    await redis.lmove(
      "taskora:{stall-events}:wait",
      "taskora:{stall-events}:active",
      "RIGHT",
      "LEFT",
    );
    await redis.hset(`taskora:{stall-events}:${jobId}`, "state", "active");

    // Start workers + event subscription
    await app.start();

    // Seed the stalled set manually (simulating Phase 2 of a previous check)
    await redis.sadd("taskora:{stall-events}:stalled", jobId);

    // Run stall check → recovered
    await adapter.stalledCheck("stall-events", 2);

    // Wait for the stalled event to propagate through the stream
    await waitFor(() => stalledEvents.length >= 1, 5_000);

    expect(stalledEvents[0]).toMatchObject({
      id: jobId,
      count: 1,
      action: "recovered",
    });

    expect(appStalledEvents[0]).toMatchObject({
      id: jobId,
      count: 1,
      action: "recovered",
      task: "stall-events",
    });

    await app.close();
  });

  it("stalledCheck two-phase seeds active IDs for next check", async () => {
    const adapter = redisAdapter(url());
    await adapter.connect();

    const app = createTaskora({ adapter });
    app.task("stall-phase2", async () => null);

    // Manually place some IDs in the active list
    await redis.lpush("taskora:{stall-phase2}:active", "job-1", "job-2", "job-3");
    // Set locks for all (they're not stalled)
    await redis.set("taskora:{stall-phase2}:job-1:lock", "tok1", "PX", 30000);
    await redis.set("taskora:{stall-phase2}:job-2:lock", "tok2", "PX", 30000);
    await redis.set("taskora:{stall-phase2}:job-3:lock", "tok3", "PX", 30000);

    // Run stall check — Phase 2 should seed the stalled set
    const result = await adapter.stalledCheck("stall-phase2", 1);
    expect(result.recovered).toEqual([]);
    expect(result.failed).toEqual([]);

    // Verify stalled set was seeded with active IDs
    const stalledMembers = await redis.smembers("taskora:{stall-phase2}:stalled");
    expect(stalledMembers.sort()).toEqual(["job-1", "job-2", "job-3"]);

    await app.close();
  });

  it("extendLock removes job from stalled set", async () => {
    const adapter = redisAdapter(url());
    await adapter.connect();

    const app = createTaskora({ adapter });
    app.task("stall-extend", async () => null);

    const jobId = "test-job-id";
    const token = "test-token";

    // Set up: job in active list with a lock, and in the stalled set
    await redis.lpush("taskora:{stall-extend}:active", jobId);
    await redis.set(`taskora:{stall-extend}:${jobId}:lock`, token, "PX", 30000);
    await redis.sadd("taskora:{stall-extend}:stalled", jobId);

    // Extend lock should remove from stalled set
    const ok = await adapter.extendLock("stall-extend", jobId, token, 30000);
    expect(ok).toBe("extended");

    // Verify removed from stalled set
    const isMember = await redis.sismember("taskora:{stall-extend}:stalled", jobId);
    expect(isMember).toBe(0);

    await app.close();
  });

  it("stalledCheck is idempotent when run concurrently", async () => {
    const adapter = redisAdapter(url());
    await adapter.connect();

    const app = createTaskora({ adapter });
    app.task("stall-idempotent", async () => null);

    const jobId = "idem-job";

    // Simulate: job in active + stalled set, no lock
    await redis.lpush("taskora:{stall-idempotent}:active", jobId);
    await redis.hset(
      `taskora:{stall-idempotent}:${jobId}`,
      "state",
      "active",
      "ts",
      String(Date.now()),
    );
    await redis.set(`taskora:{stall-idempotent}:${jobId}:data`, '"test"');
    await redis.sadd("taskora:{stall-idempotent}:stalled", jobId);

    // Run two stall checks concurrently
    const [r1, r2] = await Promise.all([
      adapter.stalledCheck("stall-idempotent", 1),
      adapter.stalledCheck("stall-idempotent", 1),
    ]);

    // One should recover, the other should find nothing
    const totalRecovered = r1.recovered.length + r2.recovered.length;
    expect(totalRecovered).toBe(1);

    await app.close();
  });
});
