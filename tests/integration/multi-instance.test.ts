import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../src/app.js";
import { createTaskora } from "../../src/index.js";
import { redisAdapter } from "../create-adapter.js";
import { url, waitFor } from "../helpers.js";

let redis: Redis;
const apps: App[] = [];

function createApp(opts?: Parameters<typeof createTaskora>[0]) {
  const app = createTaskora({ adapter: redisAdapter(url()), ...opts });
  apps.push(app);
  return app;
}

beforeEach(() => {
  redis = new Redis(url());
});

afterEach(async () => {
  // Close all app instances in parallel
  await Promise.allSettled(apps.map((a) => a.close()));
  apps.length = 0;
  await redis.flushdb();
  await redis.quit();
});

// ── Job distribution across pods ────────────────────────────────

describe("multi-instance job distribution", () => {
  it("jobs are distributed across 3 app instances without duplicates", async () => {
    const processedBy = new Map<string, string>(); // jobId → appName
    let duplicates = 0;
    const JOB_COUNT = 50;

    // Create 3 independent app instances (simulating 3 pods)
    for (let i = 1; i <= 3; i++) {
      const app = createApp();
      app.task<{ id: string }, null>("dist-task", {
        concurrency: 5,
        handler: async (data) => {
          const existing = processedBy.get(data.id);
          if (existing) duplicates++;
          processedBy.set(data.id, `app${i}`);
          // Simulate work
          await new Promise((r) => setTimeout(r, 10));
          return null;
        },
      });
    }

    // Start all 3 instances
    await Promise.all(apps.map((a) => a.start()));

    // Dispatch 50 jobs from an external dispatch-only app
    const dispatcher = createApp();
    const task = dispatcher.task<{ id: string }, null>("dist-task", async () => null);

    const handles = [];
    for (let i = 0; i < JOB_COUNT; i++) {
      handles.push(task.dispatch({ id: String(i) }));
    }
    await Promise.all(handles);

    // Wait for all jobs to complete
    await waitFor(() => processedBy.size === JOB_COUNT, 15_000);

    expect(duplicates).toBe(0);
    expect(processedBy.size).toBe(JOB_COUNT);

    // At least 2 of 3 instances should have processed something
    // (statistically guaranteed with 50 jobs and concurrency=5)
    const appsUsed = new Set(processedBy.values());
    expect(appsUsed.size).toBeGreaterThanOrEqual(2);
  });

  it("dispatch from any pod, process on any pod", async () => {
    const results: Array<{ jobId: string; dispatchedFrom: string; processedBy: string }> = [];

    // 3 pods, each registers the same task
    for (let i = 1; i <= 3; i++) {
      const app = createApp();
      app.task<{ from: string }, null>("any-pod", {
        handler: async (data, ctx) => {
          results.push({
            jobId: ctx.id,
            dispatchedFrom: data.from,
            processedBy: `app${i}`,
          });
          return null;
        },
      });
    }

    await Promise.all(apps.map((a) => a.start()));

    // Small delay for workers to be ready
    await new Promise((r) => setTimeout(r, 200));

    // Each pod dispatches a job — processor can be different
    const tasks = apps.map((app) => (app as any).tasks.get("any-pod"));
    for (let i = 0; i < 3; i++) {
      await tasks[i].dispatch({ from: `app${i + 1}` });
    }

    await waitFor(() => results.length === 3, 10_000);

    expect(results).toHaveLength(3);
    // Each job dispatched from a different pod
    const dispatchers = results.map((r) => r.dispatchedFrom).sort();
    expect(dispatchers).toEqual(["app1", "app2", "app3"]);
  });
});

// ── Event fan-out across pods ───────────────────────────────────

describe("multi-instance event fan-out", () => {
  it("all pods receive completed event (fan-out, not exactly-once)", async () => {
    const eventsPerApp: string[][] = [[], [], []];

    // 3 pods, each subscribes to completed event
    for (let i = 0; i < 3; i++) {
      const app = createApp();
      const task = app.task<string, string>("fanout-task", async (data) => data);
      task.on("completed", (ev) => {
        eventsPerApp[i].push(ev.id);
      });
    }

    await Promise.all(apps.map((a) => a.start()));

    // Dispatch one job — only one pod processes it, but all should see the event
    const task0 = (apps[0] as any).tasks.get("fanout-task");
    const handle = task0.dispatch("hello");
    await handle;

    // All 3 pods should receive the completed event
    await waitFor(() => eventsPerApp.every((events) => events.length >= 1), 10_000);

    for (let i = 0; i < 3; i++) {
      expect(eventsPerApp[i]).toContain(handle.id);
    }
  });

  it("app-level task:completed fires on all instances", async () => {
    const appEvents: string[][] = [[], []];

    for (let i = 0; i < 2; i++) {
      const app = createApp();
      app.task<string, string>("app-fanout", async (data) => data);
      app.on("task:completed", (ev) => {
        appEvents[i].push(ev.id);
      });
    }

    await Promise.all(apps.map((a) => a.start()));

    const task0 = (apps[0] as any).tasks.get("app-fanout");
    const handle = task0.dispatch("hey");
    await handle;

    await waitFor(() => appEvents.every((events) => events.length >= 1), 10_000);

    expect(appEvents[0]).toContain(handle.id);
    expect(appEvents[1]).toContain(handle.id);
  });
});

// ── Cross-pod cancel ────────────────────────────────────────────

describe("multi-instance cancellation", () => {
  it("cancel from pod-1 aborts active job on pod-2", async () => {
    let signalAborted = false;
    let handlerStartResolve: () => void;
    const handlerStarted = new Promise<void>((r) => {
      handlerStartResolve = r;
    });

    // Pod 1 — dispatch-only (no workers started)
    const pod1 = createApp();
    const taskPod1 = pod1.task<string, string>("cross-cancel", {
      timeout: 30_000,
      handler: async () => "unreachable",
    });

    // Pod 2 — the worker pod
    const pod2 = createApp();
    pod2.task<string, string>("cross-cancel", {
      timeout: 30_000,
      handler: async (_data, ctx) => {
        handlerStartResolve();
        await new Promise<void>((res) => {
          if (ctx.signal.aborted) {
            signalAborted = true;
            res();
            return;
          }
          ctx.signal.addEventListener("abort", () => {
            signalAborted = true;
            res();
          });
        });
        ctx.signal.throwIfAborted();
        return "done";
      },
    });

    // Start only pod2 workers
    await pod2.start();

    // Dispatch from pod1
    const handle = taskPod1.dispatch("test");
    await handle;

    // Wait for pod2's worker to pick it up
    await handlerStarted;

    // Cancel from pod1 — should reach pod2 via pub/sub
    await handle.cancel({ reason: "cross-pod cancel" });

    await waitFor(() => signalAborted, 5_000);
    expect(signalAborted).toBe(true);

    // Verify final state
    await waitFor(async () => {
      const state = await handle.getState();
      return state === "cancelled";
    }, 5_000);
  });

  it("onCancel hook fires on the pod processing the job", async () => {
    let hookRan = false;
    let hookDataValue: unknown = null;
    let handlerStartResolve: () => void;
    const handlerStarted = new Promise<void>((r) => {
      handlerStartResolve = r;
    });

    // Pod 1 — dispatcher
    const pod1 = createApp();
    const taskPod1 = pod1.task<{ key: string }, string>("cross-hook", {
      timeout: 30_000,
      handler: async () => "unreachable",
    });

    // Pod 2 — worker with onCancel hook
    const pod2 = createApp();
    pod2.task<{ key: string }, string>("cross-hook", {
      timeout: 30_000,
      onCancel: async (data) => {
        hookRan = true;
        hookDataValue = data;
      },
      handler: async (_data, ctx) => {
        handlerStartResolve();
        await new Promise<void>((res) => {
          ctx.signal.addEventListener("abort", () => res());
          if (ctx.signal.aborted) res();
        });
        ctx.signal.throwIfAborted();
        return "done";
      },
    });

    await pod2.start();

    const handle = taskPod1.dispatch({ key: "abc" });
    await handle;
    await handlerStarted;

    await handle.cancel({ reason: "hook test" });

    await waitFor(() => hookRan, 5_000);
    expect(hookRan).toBe(true);
    expect(hookDataValue).toEqual({ key: "abc" });
  });
});

// ── Stall recovery across pods ──────────────────────────────────

describe("multi-instance stall recovery", () => {
  it("pod-2 recovers stalled job from crashed pod-1", async () => {
    let pod2Processed = false;
    let pod2JobId: string | null = null;

    // Pod 1 — dispatch only (simulates a pod that dispatched and crashed)
    const pod1 = createApp();
    const task1 = pod1.task<{ msg: string }, null>("stall-cross", {
      stall: { interval: 300, maxCount: 1 },
      handler: async () => null,
    });

    const handle = task1.dispatch({ msg: "recover-me" });
    await handle;

    // Simulate pod-1 crash: manually move job to active without a lock
    // (as if the worker dequeued it, then the process died and the lock expired)
    await redis.lmove(
      "taskora:{stall-cross}:wait",
      "taskora:{stall-cross}:active",
      "RIGHT",
      "LEFT",
    );
    await redis.hset(`taskora:{stall-cross}:${handle.id}`, "state", "active");
    // No lock set — simulates expired lock after crash

    // Pod 2 — healthy pod with stall detection should recover the job
    const pod2 = createApp();
    pod2.task<{ msg: string }, null>("stall-cross", {
      stall: { interval: 300, maxCount: 1 },
      handler: async (data, ctx) => {
        pod2Processed = true;
        pod2JobId = ctx.id;
        return null;
      },
    });

    await pod2.start();

    // Pod 2's stall check should detect the lockless active job and recover it
    await waitFor(() => pod2Processed, 10_000);

    expect(pod2Processed).toBe(true);
    expect(pod2JobId).toBe(handle.id);

    // Final state should be completed
    const finalState = await handle.getState();
    expect(finalState).toBe("completed");
  });
});

// ── Singleton across pods ───────────────────────────────────────

describe("multi-instance singleton", () => {
  it("only one job runs at a time across all pods", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let totalProcessed = 0;

    // 3 pods, each with a singleton task
    for (let i = 0; i < 3; i++) {
      const app = createApp();
      app.task<{ id: number }, null>("singleton-multi", {
        singleton: true,
        handler: async (data) => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 50));
          concurrent--;
          totalProcessed++;
          return null;
        },
      });
    }

    await Promise.all(apps.map((a) => a.start()));

    // Dispatch several jobs — singleton ensures only 1 active at a time
    const dispatcher = createApp();
    const task = dispatcher.task<{ id: number }, null>("singleton-multi", async () => null);

    for (let i = 0; i < 6; i++) {
      task.dispatch({ id: i });
    }

    await waitFor(() => totalProcessed === 6, 15_000);

    expect(totalProcessed).toBe(6);
    // Singleton: at most 1 concurrent execution across all pods
    expect(maxConcurrent).toBe(1);
  });
});
