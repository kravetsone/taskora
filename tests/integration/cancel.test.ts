import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CancelledError, taskora } from "../../src/index.js";
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

describe("graceful cancellation", () => {
  it("cancel waiting job → state is 'cancelled'", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    const t = app.task<string, string>("cancel-wait", {
      handler: async (data) => data,
    });

    // Dispatch but don't start workers — job stays in waiting
    const handle = t.dispatch("hello");
    await handle;

    const stateBefore = await handle.getState();
    expect(stateBefore).toBe("waiting");

    await handle.cancel({ reason: "user requested" });

    const stateAfter = await handle.getState();
    expect(stateAfter).toBe("cancelled");

    // Should be in cancelled sorted set
    const cancelledCount = await redis.zcard("taskora:{cancel-wait}:cancelled");
    expect(cancelledCount).toBe(1);

    // Should NOT be in waiting list
    const waitingCount = await redis.llen("taskora:{cancel-wait}:wait");
    expect(waitingCount).toBe(0);

    await app.close();
  });

  it("cancel delayed job → state is 'cancelled'", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    const t = app.task<string, string>("cancel-delayed", {
      handler: async (data) => data,
    });

    const handle = t.dispatch("hello", { delay: 60_000 });
    await handle;

    const stateBefore = await handle.getState();
    expect(stateBefore).toBe("delayed");

    await handle.cancel();

    const stateAfter = await handle.getState();
    expect(stateAfter).toBe("cancelled");

    // Should be in cancelled sorted set
    const cancelledCount = await redis.zcard("taskora:{cancel-delayed}:cancelled");
    expect(cancelledCount).toBe(1);

    // Should NOT be in delayed set
    const delayedCount = await redis.zcard("taskora:{cancel-delayed}:delayed");
    expect(delayedCount).toBe(0);

    await app.close();
  });

  it("cancel retrying job → state is 'cancelled'", async () => {
    let attempts = 0;
    const app = taskora({ adapter: redisAdapter(url()) });

    const t = app.task<string, string>("cancel-retrying", {
      retry: { attempts: 3, delay: 60_000 },
      handler: async () => {
        attempts++;
        throw new Error("fail");
      },
    });

    const handle = t.dispatch("hello");
    await app.start();

    // Wait for first attempt to fail and move to retrying
    await waitFor(async () => {
      const state = await handle.getState();
      return state === "retrying";
    });
    expect(attempts).toBe(1);

    await handle.cancel({ reason: "abort retry" });

    const stateAfter = await handle.getState();
    expect(stateAfter).toBe("cancelled");

    await app.close();
  });

  it("cancel completed job → not cancellable (no-op)", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    const t = app.task<string, string>("cancel-completed", {
      handler: async (data) => data,
    });

    const handle = t.dispatch("hello");
    await app.start();

    // Wait for completion
    await handle.result;

    const stateAfter = await handle.getState();
    expect(stateAfter).toBe("completed");

    // Cancel should be a no-op (already terminal)
    await handle.cancel();

    // State unchanged
    expect(await handle.getState()).toBe("completed");

    await app.close();
  });

  it("cancel active job → handler aborted via ctx.signal", async () => {
    let signalAborted = false;
    let abortReason: unknown = null;
    let handlerStartResolve: () => void;
    const handlerStarted = new Promise<void>((r) => {
      handlerStartResolve = r;
    });

    const app = taskora({ adapter: redisAdapter(url()) });

    const t = app.task<string, string>("cancel-active", {
      timeout: 30_000,
      handler: async (_data, ctx) => {
        handlerStartResolve();
        // Wait until signal fires
        await new Promise<void>((res) => {
          if (ctx.signal.aborted) {
            signalAborted = true;
            abortReason = ctx.signal.reason;
            res();
            return;
          }
          ctx.signal.addEventListener("abort", () => {
            signalAborted = true;
            abortReason = ctx.signal.reason;
            res();
          });
        });
        ctx.signal.throwIfAborted();
        return "done";
      },
    });

    const handle = t.dispatch("hello");
    await app.start();

    // Wait for handler to start
    await handlerStarted;

    // Cancel the active job
    await handle.cancel({ reason: "user abort" });

    // Pub/sub delivers cancel signal near-instantly
    await waitFor(() => signalAborted, 5_000);

    expect(signalAborted).toBe(true);
    expect(abortReason).toBe("cancelled");

    // Wait for state to be cancelled
    await waitFor(async () => {
      const state = await handle.getState();
      return state === "cancelled";
    }, 5_000);

    await app.close();
  });

  it("onCancel hook runs on active cancellation", async () => {
    let hookRan = false;
    let hookData: unknown = null;
    let handlerStartResolve2: () => void;
    const handlerStartedPromise = new Promise<void>((r) => {
      handlerStartResolve2 = r;
    });

    const app = taskora({ adapter: redisAdapter(url()) });

    const t = app.task<{ importId: string }, string>("cancel-hook", {
      timeout: 30_000,
      onCancel: async (data) => {
        hookRan = true;
        hookData = data;
      },
      handler: async (_data, ctx) => {
        handlerStartResolve2();
        await new Promise<void>((res) => {
          ctx.signal.addEventListener("abort", () => res());
          if (ctx.signal.aborted) res();
        });
        ctx.signal.throwIfAborted();
        return "done";
      },
    });

    const handle = t.dispatch({ importId: "imp-123" });
    await app.start();

    await handlerStartedPromise;

    await handle.cancel({ reason: "cleanup needed" });

    // Pub/sub delivers cancel signal near-instantly
    await waitFor(() => hookRan, 5_000);

    expect(hookRan).toBe(true);
    expect(hookData).toEqual({ importId: "imp-123" });

    // State should be cancelled
    await waitFor(async () => {
      const state = await handle.getState();
      return state === "cancelled";
    }, 5_000);

    await app.close();
  });

  it("cancelled event fires on task and app emitters", async () => {
    const taskEvents: Array<{ id: string; reason?: string }> = [];
    const appEvents: Array<{ id: string; reason?: string; task: string }> = [];

    const app = taskora({ adapter: redisAdapter(url()) });

    const t = app.task<string, string>("cancel-events", {
      handler: async (data) => data,
    });

    t.on("cancelled", (ev) => taskEvents.push(ev));
    app.on("task:cancelled", (ev) => appEvents.push(ev));

    // Start workers first so subscription is active and stream position is snapshotted
    await app.start();

    // Now dispatch and cancel
    const handle = t.dispatch("hello");
    await handle;

    await handle.cancel({ reason: "test cancel" });

    // Wait for events to propagate (stream-based)
    await waitFor(() => taskEvents.length >= 1, 5_000);
    await waitFor(() => appEvents.length >= 1, 5_000);

    expect(taskEvents[0].id).toBe(handle.id);
    expect(taskEvents[0].reason).toBe("test cancel");
    expect(appEvents[0].id).toBe(handle.id);
    expect(appEvents[0].task).toBe("cancel-events");

    await app.close();
  });

  it("inspector.cancelled() lists cancelled jobs", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    const t = app.task<string, string>("cancel-inspect", {
      handler: async (data) => data,
    });

    const h1 = t.dispatch("a");
    const h2 = t.dispatch("b");
    const h3 = t.dispatch("c");
    await Promise.all([h1, h2, h3]);

    await h1.cancel({ reason: "r1" });
    await h2.cancel({ reason: "r2" });

    const cancelled = await app.inspect().cancelled({ task: "cancel-inspect" });
    expect(cancelled).toHaveLength(2);

    const ids = cancelled.map((j) => j.id);
    expect(ids).toContain(h1.id);
    expect(ids).toContain(h2.id);

    // Stats
    const stats = await app.inspect().stats({ task: "cancel-inspect" });
    expect(stats.cancelled).toBe(2);
    expect(stats.waiting).toBe(1);

    await app.close();
  });

  it("waitFor() on cancelled job throws CancelledError", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    const t = app.task<string, string>("cancel-wait-for", {
      handler: async (data) => data,
    });

    const handle = t.dispatch("hello");
    await handle;

    await handle.cancel({ reason: "nope" });

    await expect(handle.result).rejects.toThrow(CancelledError);

    await app.close();
  });

  it("cancel preserves cancelReason in job hash", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    const t = app.task<string, string>("cancel-reason", {
      handler: async (data) => data,
    });

    const handle = t.dispatch("hello");
    await handle;

    await handle.cancel({ reason: "budget exceeded" });

    const reason = await redis.hget(`taskora:{cancel-reason}:${handle.id}`, "cancelReason");
    expect(reason).toBe("budget exceeded");

    await app.close();
  });
});
