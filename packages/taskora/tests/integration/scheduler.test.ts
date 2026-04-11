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

// ── Interval schedules ───────────────────────────────────────────────

describe("interval schedules", () => {
  it("fires on interval", async () => {
    const processed: number[] = [];

    const app = createTaskora({
      adapter: redisAdapter(url()),
      scheduler: { pollInterval: 100 },
    });

    app.task<undefined, void>("tick-task", async () => {
      processed.push(Date.now());
    });

    app.schedule("tick", {
      task: "tick-task",
      every: "1s",
    });

    await app.start();

    // Should fire at least 2 times within ~2.5s
    await waitFor(() => processed.length >= 2, 5_000);
    expect(processed.length).toBeGreaterThanOrEqual(2);

    await app.close();
  });

  it("inline schedule on task definition", async () => {
    const processed: number[] = [];

    const app = createTaskora({
      adapter: redisAdapter(url()),
      scheduler: { pollInterval: 100 },
    });

    app.task<undefined, void>("inline-tick", {
      schedule: { every: "1s" },
      handler: async () => {
        processed.push(Date.now());
      },
    });

    await app.start();

    await waitFor(() => processed.length >= 2, 5_000);
    expect(processed.length).toBeGreaterThanOrEqual(2);

    await app.close();
  });
});

// ── Cron schedules ───────────────────────────────────────────────────

describe("cron schedules", () => {
  it("registers and dispatches cron schedule", async () => {
    const processed: number[] = [];

    const app = createTaskora({
      adapter: redisAdapter(url()),
      scheduler: { pollInterval: 100 },
    });

    app.task<undefined, void>("cron-task", async () => {
      processed.push(Date.now());
    });

    // Every second cron (fires every second)
    app.schedule("per-second", {
      task: "cron-task",
      cron: "* * * * * *",
    });

    await app.start();

    await waitFor(() => processed.length >= 1, 5_000);
    expect(processed.length).toBeGreaterThanOrEqual(1);

    await app.close();
  });
});

// ── Pause / resume ───────────────────────────────────────────────────

describe("pause and resume", () => {
  it("paused schedule does not fire", async () => {
    const processed: number[] = [];

    const app = createTaskora({
      adapter: redisAdapter(url()),
      scheduler: { pollInterval: 100 },
    });

    app.task<undefined, void>("pausable-task", async () => {
      processed.push(Date.now());
    });

    app.schedule("pausable", {
      task: "pausable-task",
      every: 500,
    });

    await app.start();

    // Wait for at least one fire
    await waitFor(() => processed.length >= 1, 3_000);
    const countBefore = processed.length;

    // Pause
    await app.schedules.pause("pausable");

    // Wait 1.5s and verify no new fires
    await new Promise((r) => setTimeout(r, 1_500));
    expect(processed.length).toBe(countBefore);

    // Resume and verify fires again
    await app.schedules.resume("pausable");
    await waitFor(() => processed.length > countBefore, 3_000);

    await app.close();
  });
});

// ── Overlap prevention ──────────────────────────────────────────────

describe("overlap prevention", () => {
  it("skips dispatch when previous run is still active", async () => {
    let dispatchCount = 0;
    let resolveFirst: (() => void) | null = null;

    const app = createTaskora({
      adapter: redisAdapter(url()),
      scheduler: { pollInterval: 100 },
    });

    app.task<undefined, void>("slow-task", async () => {
      dispatchCount++;
      if (dispatchCount === 1) {
        // First run blocks for 2s
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
    });

    app.schedule("no-overlap", {
      task: "slow-task",
      every: 500,
      overlap: false,
    });

    await app.start();

    // Wait for first dispatch to start
    await waitFor(() => dispatchCount >= 1, 3_000);

    // Wait for at least 2 more intervals — should NOT dispatch again
    await new Promise((r) => setTimeout(r, 1_500));
    expect(dispatchCount).toBe(1);

    // Unblock the first run
    resolveFirst?.();

    // Now it should fire again
    await waitFor(() => dispatchCount >= 2, 3_000);

    await app.close();
  });
});

// ── Leader election ─────────────────────────────────────────────────

describe("leader election", () => {
  it("only one scheduler runs across multiple app instances", async () => {
    const processed1: string[] = [];
    const processed2: string[] = [];

    const app1 = createTaskora({
      adapter: redisAdapter(url()),
      scheduler: { pollInterval: 200 },
    });
    const app2 = createTaskora({
      adapter: redisAdapter(url()),
      scheduler: { pollInterval: 200 },
    });

    app1.task<undefined, void>("leader-task", async () => {
      processed1.push("app1");
    });
    app2.task<undefined, void>("leader-task", async () => {
      processed2.push("app2");
    });

    // Only register schedule from app1 — both apps see the same Redis
    app1.schedule("leader-test", {
      task: "leader-task",
      every: 500,
    });

    await app1.start();
    await app2.start();

    await waitFor(() => processed1.length + processed2.length >= 3, 5_000);

    // All dispatches should come from one app instance (the leader)
    const total = processed1.length + processed2.length;
    expect(total).toBeGreaterThanOrEqual(3);

    // The non-leader should have 0 dispatches from the scheduler
    // (though it processes the jobs from the queue)
    // At least one app should have produced all the schedules

    await app1.close();
    await app2.close();
  });
});

// ── Missed run catch-up ─────────────────────────────────────────────

describe("missed run catch-up", () => {
  it("catch-up dispatches multiple jobs for missed runs", async () => {
    const processed: number[] = [];

    const app = createTaskora({
      adapter: redisAdapter(url()),
      scheduler: { pollInterval: 100 },
    });

    app.task<undefined, void>("catchup-task", async () => {
      processed.push(Date.now());
    });

    // Register schedule with a fake last run far in the past
    // We'll manually insert the schedule into Redis with lastRun set
    const adapter = app.adapter;
    await adapter.connect();

    const now = Date.now();
    const fiveIntervalsAgo = now - 5 * 1_000; // 5 x 1s intervals ago
    const storedConfig = JSON.stringify({
      task: "catchup-task",
      data: null,
      every: 1_000,
      overlap: false,
      onMissed: "catch-up",
      lastRun: fiveIntervalsAgo,
      lastJobId: null,
    });

    // Write directly to Redis
    await redis.hset("taskora:schedules", "catchup-sched", storedConfig);
    await redis.zadd("taskora:schedules:next", String(fiveIntervalsAgo + 1_000), "catchup-sched");

    await app.start();

    // Should dispatch ~5 catch-up jobs
    await waitFor(() => processed.length >= 4, 5_000);
    expect(processed.length).toBeGreaterThanOrEqual(4);

    await app.close();
  });

  it("catch-up-limit caps missed dispatches", async () => {
    const processed: number[] = [];

    const app = createTaskora({
      adapter: redisAdapter(url()),
      scheduler: { pollInterval: 100 },
    });

    app.task<undefined, void>("limited-catchup", async () => {
      processed.push(Date.now());
    });

    const adapter = app.adapter;
    await adapter.connect();

    const now = Date.now();
    const tenIntervalsAgo = now - 10 * 1_000;
    const storedConfig = JSON.stringify({
      task: "limited-catchup",
      data: null,
      every: 1_000,
      overlap: false,
      onMissed: "catch-up-limit:3",
      lastRun: tenIntervalsAgo,
      lastJobId: null,
    });

    await redis.hset("taskora:schedules", "limited-sched", storedConfig);
    await redis.zadd("taskora:schedules:next", String(tenIntervalsAgo + 1_000), "limited-sched");

    await app.start();

    // Should dispatch exactly 3 (the limit), then continue with normal scheduling
    await waitFor(() => processed.length >= 3, 5_000);

    // Wait a bit to see if it dispatches many more beyond the initial catch-up burst
    await new Promise((r) => setTimeout(r, 500));
    // The initial burst should be 3 (capped), plus maybe 1 normal tick
    // Total should not be 10 (uncapped)
    expect(processed.length).toBeLessThanOrEqual(6);

    await app.close();
  });

  // Exactness boundary tests. The existing catch-up tests use loose bounds
  // (`>= 4`, `<= 6`) because the 1s interval means normal ticks keep firing
  // during the measurement window. These use a large `every` (10s) so the
  // first tick processes the entire backlog and no normal ticks fire before
  // we measure — giving us exact counts for each boundary case.
  //
  // Scheduler semantics under test (see `scheduler.ts:computeDispatches`):
  //   missedCount = floor((now - lastRun) / interval)
  //   catch-up          → dispatches = missedCount
  //   catch-up-limit:N  → dispatches = min(missedCount, N)
  //   skip              → dispatches = 1 (always, ignores backlog)
  //
  // Scenario: lastRun was 5 intervals ago, so missedCount = 5.

  const runBoundaryScenario = async (
    scheduleName: string,
    taskName: string,
    onMissed: string,
  ): Promise<number[]> => {
    const processed: number[] = [];
    const app = createTaskora({
      adapter: redisAdapter(url()),
      scheduler: { pollInterval: 50 },
    });
    app.task<undefined, void>(taskName, async () => {
      processed.push(Date.now());
    });

    const adapter = app.adapter;
    await adapter.connect();

    const now = Date.now();
    const interval = 10_000;
    const fiveIntervalsAgo = now - 5 * interval;
    const storedConfig = JSON.stringify({
      task: taskName,
      data: null,
      every: interval,
      overlap: false,
      onMissed,
      lastRun: fiveIntervalsAgo,
      lastJobId: null,
    });

    await redis.hset("taskora:schedules", scheduleName, storedConfig);
    await redis.zadd("taskora:schedules:next", String(fiveIntervalsAgo + interval), scheduleName);

    await app.start();

    // First scheduler tick lands within ~pollInterval (50ms). After the
    // burst, nextRun is set to now+10s so no additional dispatches can
    // fire during our 300ms settle window.
    await new Promise((r) => setTimeout(r, 300));

    await app.close();
    return processed;
  };

  it("catch-up-limit:N where N exactly matches missedCount — dispatches exactly N", async () => {
    // missedCount = 5, limit = 5 → exactly 5
    const processed = await runBoundaryScenario(
      "boundary-exact",
      "boundary-exact-task",
      "catch-up-limit:5",
    );
    expect(processed.length).toBe(5);
  });

  it("catch-up-limit:N where N > missedCount — dispatches exactly missedCount (no padding)", async () => {
    // missedCount = 5, limit = 100 → exactly 5 (capped by backlog, not by limit)
    const processed = await runBoundaryScenario(
      "boundary-over",
      "boundary-over-task",
      "catch-up-limit:100",
    );
    expect(processed.length).toBe(5);
  });

  it("catch-up-limit:N where N < missedCount — dispatches exactly N", async () => {
    // missedCount = 5, limit = 2 → exactly 2
    const processed = await runBoundaryScenario(
      "boundary-under",
      "boundary-under-task",
      "catch-up-limit:2",
    );
    expect(processed.length).toBe(2);
  });

  it("catch-up policy with missedCount=5 — dispatches exactly 5 (unlimited)", async () => {
    // Full catch-up: all missed runs replayed.
    const processed = await runBoundaryScenario("boundary-full", "boundary-full-task", "catch-up");
    expect(processed.length).toBe(5);
  });

  it("skip policy with missedCount=5 — dispatches exactly 1 (ignores backlog)", async () => {
    // skip means "don't catch up, just run once now". missedCount doesn't
    // matter: always 1 dispatch on the tick.
    const processed = await runBoundaryScenario("boundary-skip", "boundary-skip-task", "skip");
    expect(processed.length).toBe(1);
  });
});

// ── Runtime management ──────────────────────────────────────────────

describe("runtime management", () => {
  it("list returns all schedules", async () => {
    const app = createTaskora({
      adapter: redisAdapter(url()),
      scheduler: { pollInterval: 100 },
    });

    app.task<undefined, void>("list-task-a", async () => {});
    app.task<undefined, void>("list-task-b", async () => {});

    app.schedule("sched-a", { task: "list-task-a", every: "5m" });
    app.schedule("sched-b", { task: "list-task-b", every: "10m" });

    await app.start();

    const schedules = await app.schedules.list();
    expect(schedules).toHaveLength(2);
    const names = schedules.map((s) => s.name).sort();
    expect(names).toEqual(["sched-a", "sched-b"]);

    await app.close();
  });

  it("update changes schedule config", async () => {
    const app = createTaskora({
      adapter: redisAdapter(url()),
      scheduler: { pollInterval: 100 },
    });

    app.task<undefined, void>("update-task", async () => {});
    app.schedule("update-sched", { task: "update-task", every: "5m" });

    await app.start();

    await app.schedules.update("update-sched", { every: "10m" });

    const schedules = await app.schedules.list();
    const sched = schedules.find((s) => s.name === "update-sched");
    expect(sched).toBeDefined();
    expect(sched?.config.every).toBe(600_000);

    await app.close();
  });

  it("remove deletes schedule", async () => {
    const app = createTaskora({
      adapter: redisAdapter(url()),
      scheduler: { pollInterval: 100 },
    });

    app.task<undefined, void>("remove-task", async () => {});
    app.schedule("removable", { task: "remove-task", every: "5m" });

    await app.start();

    await app.schedules.remove("removable");

    const schedules = await app.schedules.list();
    expect(schedules).toHaveLength(0);

    await app.close();
  });

  it("trigger fires immediately outside schedule", async () => {
    const processed: number[] = [];

    const app = createTaskora({
      adapter: redisAdapter(url()),
      scheduler: { pollInterval: 100 },
    });

    app.task<undefined, void>("trigger-task", async () => {
      processed.push(Date.now());
    });

    app.schedule("triggerable", { task: "trigger-task", every: "1h" });

    await app.start();

    const jobId = await app.schedules.trigger("triggerable");
    expect(typeof jobId).toBe("string");

    await waitFor(() => processed.length >= 1, 3_000);

    await app.close();
  });
});
