import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DuplicateJobError, ThrottledError, createTaskora } from "../../src/index.js";
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

// ── Debounce ────────────────────────────────────────────────────────

describe("debounce", () => {
  it("5 rapid dispatches — only the last one runs", async () => {
    const processed: number[] = [];

    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("debounce-test", async (data: { n: number }) => {
      processed.push(data.n);
    });

    // Dispatch 5 times with same debounce key
    for (let i = 1; i <= 5; i++) {
      const h = task.dispatch(
        { n: i },
        {
          debounce: { key: "same-key", delay: "1s" },
        },
      );
      await h; // ensure enqueued
    }

    // Only 1 job should be in delayed
    const delayedCount = await redis.zcard("taskora:{debounce-test}:delayed");
    expect(delayedCount).toBe(1);

    await app.start();

    // Wait for the debounced job to be promoted and processed
    await waitFor(() => processed.length === 1, 5000);
    expect(processed).toEqual([5]); // only the last dispatch ran

    await app.close();
  });

  it("debounce replaces previous job data", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("debounce-data", async (data: { value: string }) => {
      return data.value;
    });

    const h1 = task.dispatch(
      { value: "old" },
      {
        debounce: { key: "replace-key", delay: "1s" },
      },
    );
    await h1;

    const h2 = task.dispatch(
      { value: "new" },
      {
        debounce: { key: "replace-key", delay: "1s" },
      },
    );
    await h2;

    await app.start();
    const result = await h2.waitFor(5000);
    expect(result).toBe("new");

    await app.close();
  });

  it("different debounce keys are independent", async () => {
    const processed: string[] = [];

    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("debounce-multi", async (data: { key: string }) => {
      processed.push(data.key);
    });

    await task.dispatch({ key: "a" }, { debounce: { key: "key-a", delay: "1s" } });
    await task.dispatch({ key: "b" }, { debounce: { key: "key-b", delay: "1s" } });

    const delayedCount = await redis.zcard("taskora:{debounce-multi}:delayed");
    expect(delayedCount).toBe(2);

    await app.start();
    await waitFor(() => processed.length === 2, 5000);
    expect(processed.sort()).toEqual(["a", "b"]);

    await app.close();
  });
});

// ── Throttle ────────────────────────────────────────────────────────

describe("throttle", () => {
  it("allows up to max dispatches, drops excess", async () => {
    const processed: number[] = [];

    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("throttle-test", async (data: { n: number }) => {
      processed.push(data.n);
    });

    const handles = [];
    for (let i = 1; i <= 5; i++) {
      const h = task.dispatch(
        { n: i },
        {
          throttle: { key: "limit-key", max: 3, window: "10s" },
        },
      );
      await h;
      handles.push(h);
    }

    // First 3 should be enqueued, last 2 dropped
    expect(handles[0].enqueued).toBe(true);
    expect(handles[1].enqueued).toBe(true);
    expect(handles[2].enqueued).toBe(true);
    expect(handles[3].enqueued).toBe(false);
    expect(handles[4].enqueued).toBe(false);

    const waitingCount = await redis.llen("taskora:{throttle-test}:wait");
    expect(waitingCount).toBe(3);

    await app.start();
    await waitFor(() => processed.length === 3);
    // This test is about "exactly 3 accepted, rest dropped" — not about
    // execution order. Same-millisecond dispatches within a priority
    // band fall back to unspecified order, so we assert set equality,
    // not array equality.
    expect(processed.sort()).toEqual([1, 2, 3]);

    await app.close();
  });

  it("throttle window resets after expiry", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("throttle-reset", async (data: { n: number }) => {
      return data.n;
    });

    // Fill the window
    for (let i = 0; i < 2; i++) {
      await task.dispatch(
        { n: i },
        {
          throttle: { key: "reset-key", max: 2, window: 200 },
        },
      );
    }

    // 3rd should be dropped
    const dropped = task.dispatch(
      { n: 99 },
      {
        throttle: { key: "reset-key", max: 2, window: 200 },
      },
    );
    await dropped;
    expect(dropped.enqueued).toBe(false);

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 300));

    // Now should be accepted again
    const fresh = task.dispatch(
      { n: 100 },
      {
        throttle: { key: "reset-key", max: 2, window: 200 },
      },
    );
    await fresh;
    expect(fresh.enqueued).toBe(true);

    await app.close();
  });

  it("throwOnReject throws ThrottledError", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("throttle-throw", async () => {});

    await task.dispatch(
      {},
      {
        throttle: { key: "throw-key", max: 1, window: "10s" },
      },
    );

    const handle = task.dispatch(
      {},
      {
        throttle: { key: "throw-key", max: 1, window: "10s" },
        throwOnReject: true,
      },
    );

    await expect(handle.ensureEnqueued()).rejects.toThrow(ThrottledError);

    await app.close();
  });

  it("different throttle keys are independent", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("throttle-multi", async () => {});

    const h1 = task.dispatch(
      {},
      {
        throttle: { key: "user-1", max: 1, window: "10s" },
      },
    );
    await h1;
    expect(h1.enqueued).toBe(true);

    const h2 = task.dispatch(
      {},
      {
        throttle: { key: "user-2", max: 1, window: "10s" },
      },
    );
    await h2;
    expect(h2.enqueued).toBe(true);

    await app.close();
  });

  // Exactness regression: the sequential "5 one after another with max=3"
  // case is cheap and the existing test covers it. The interesting cases are
  // (a) real concurrent burst — all dispatches fire synchronously and race
  // through the Lua script, and (b) large burst where off-by-one in the Lua
  // ZCARD/ZADD pair would leak an extra one. Both are easy to regress with
  // an innocent "let me inline the check" refactor in throttle-enqueue.lua.

  it("concurrent burst — exactly max accepted, rest rejected", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("throttle-burst", async () => {});

    // Fire 20 dispatches in parallel with max=5. All Lua script invocations
    // race against the same `throttle:burst-key` ZSET — only 5 should win.
    // Without `throwOnReject`, rejection sets `handle.enqueued = false` and
    // resolves normally, so we inspect the field after awaiting.
    const handles = Array.from({ length: 20 }, () =>
      task.dispatch({}, { throttle: { key: "burst-key", max: 5, window: "10s" } }),
    );
    await Promise.all(handles.map((h) => h.ensureEnqueued()));

    const accepted = handles.filter((h) => h.enqueued === true).length;
    const rejected = handles.filter((h) => h.enqueued === false).length;
    expect(accepted).toBe(5);
    expect(rejected).toBe(15);

    const waitingCount = await redis.llen("taskora:{throttle-burst}:wait");
    expect(waitingCount).toBe(5);

    await app.close();
  });

  it("N+1-th dispatch at the boundary — exactly one rejected", async () => {
    // Fire max+1 in a tight synchronous loop — all dispatches enter the
    // adapter layer in the same tick and race through the Lua script. The
    // contract is "no more than max accepted", not "the LAST one is the one
    // that loses" — ioredis pipelining + NOSCRIPT-fallback retries make the
    // Lua-invocation order nondeterministic on a fresh connection. We only
    // assert the count invariant.
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("throttle-boundary", async () => {});

    const max = 3;
    const handles = Array.from({ length: max + 1 }, () =>
      task.dispatch({}, { throttle: { key: "edge-key", max, window: "10s" } }),
    );
    await Promise.all(handles.map((h) => h.ensureEnqueued()));

    const accepted = handles.filter((h) => h.enqueued === true).length;
    const rejected = handles.filter((h) => h.enqueued === false).length;
    expect(accepted).toBe(max);
    expect(rejected).toBe(1);

    const waitingCount = await redis.llen("taskora:{throttle-boundary}:wait");
    expect(waitingCount).toBe(max);

    await app.close();
  });

  it("exactness under sustained burst — no drift across multiple max-sized waves", async () => {
    // Fill the window exactly to max, then fire another 10. All 10 rejected.
    // Then wait for the window to fully expire, fire max + 5. Exactly max
    // accepted, 5 rejected. Catches off-by-one drift between ZREMRANGEBYSCORE
    // expiry and ZADD entry timestamp.
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("throttle-sustained", async () => {});

    const max = 4;
    const window = 150;

    const wave1 = Array.from({ length: max + 10 }, () =>
      task.dispatch({}, { throttle: { key: "sustained-key", max, window } }),
    );
    await Promise.all(wave1.map((h) => h.ensureEnqueued()));
    expect(wave1.filter((h) => h.enqueued === true).length).toBe(max);

    // Wait for the window to expire — generous slack so we don't race the
    // boundary.
    await new Promise((r) => setTimeout(r, window + 100));

    const wave2 = Array.from({ length: max + 5 }, () =>
      task.dispatch({}, { throttle: { key: "sustained-key", max, window } }),
    );
    await Promise.all(wave2.map((h) => h.ensureEnqueued()));
    expect(wave2.filter((h) => h.enqueued === true).length).toBe(max);

    // Total enqueued across both waves = 2 * max.
    const waitingCount = await redis.llen("taskora:{throttle-sustained}:wait");
    expect(waitingCount).toBe(2 * max);

    await app.close();
  });
});

// ── Deduplication ───────────────────────────────────────────────────

describe("deduplication", () => {
  it("second dispatch returns existing handle", async () => {
    const processed: number[] = [];

    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("dedup-test", async (data: { n: number }) => {
      processed.push(data.n);
      return data.n;
    });

    const h1 = task.dispatch(
      { n: 1 },
      {
        deduplicate: { key: "sync-123" },
      },
    );
    await h1;
    expect(h1.enqueued).toBe(true);

    const h2 = task.dispatch(
      { n: 2 },
      {
        deduplicate: { key: "sync-123" },
      },
    );
    await h2;
    expect(h2.enqueued).toBe(false);
    expect(h2.existingId).toBe(h1.id);

    // Only 1 job in queue
    const waitingCount = await redis.llen("taskora:{dedup-test}:wait");
    expect(waitingCount).toBe(1);

    await app.start();
    await waitFor(() => processed.length === 1);
    expect(processed).toEqual([1]); // only first dispatch ran

    await app.close();
  });

  it("dedup handle redirects to existing job for getState/result", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("dedup-redirect", async (data: { n: number }) => {
      return data.n * 10;
    });

    const h1 = task.dispatch(
      { n: 5 },
      {
        deduplicate: { key: "redirect-key" },
      },
    );
    await h1;

    const h2 = task.dispatch(
      { n: 99 },
      {
        deduplicate: { key: "redirect-key" },
      },
    );
    await h2;
    expect(h2.enqueued).toBe(false);

    await app.start();

    // h2 should get h1's result (50, not 990)
    const result = await h2.waitFor(5000);
    expect(result).toBe(50);

    await app.close();
  });

  it("dedup key clears after job completes — re-dispatch works", async () => {
    const processed: number[] = [];

    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("dedup-clear", async (data: { n: number }) => {
      processed.push(data.n);
      return data.n;
    });

    const h1 = task.dispatch(
      { n: 1 },
      {
        deduplicate: { key: "clear-key" },
      },
    );
    await h1;

    await app.start();
    await h1.waitFor(5000);

    // Job completed — dedup key should be cleared
    // Wait a tick for the ack to clean up
    await new Promise((r) => setTimeout(r, 100));

    const h3 = task.dispatch(
      { n: 3 },
      {
        deduplicate: { key: "clear-key" },
      },
    );
    await h3;
    expect(h3.enqueued).toBe(true);

    await waitFor(() => processed.length === 2);
    expect(processed).toEqual([1, 3]);

    await app.close();
  });

  it("dedup while option — only blocks in specified states", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("dedup-while", async (data: { n: number }) => {
      // Slow handler to keep job active
      await new Promise((r) => setTimeout(r, 500));
      return data.n;
    });

    const h1 = task.dispatch(
      { n: 1 },
      {
        deduplicate: { key: "while-key", while: ["waiting", "delayed"] },
      },
    );
    await h1;

    await app.start();

    // Wait for job to become active
    await waitFor(async () => {
      const state = await h1.getState();
      return state === "active";
    });

    // Now dispatch with while: ["waiting", "delayed"] — should NOT deduplicate
    // because h1 is "active" and that's not in the while list
    const h2 = task.dispatch(
      { n: 2 },
      {
        deduplicate: { key: "while-key", while: ["waiting", "delayed"] },
      },
    );
    await h2;
    expect(h2.enqueued).toBe(true);

    await app.close();
  });

  it("throwOnReject throws DuplicateJobError", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("dedup-throw", async () => {});

    await task.dispatch(
      {},
      {
        deduplicate: { key: "throw-key" },
      },
    );

    const handle = task.dispatch(
      {},
      {
        deduplicate: { key: "throw-key" },
        throwOnReject: true,
      },
    );

    await expect(handle.ensureEnqueued()).rejects.toThrow(DuplicateJobError);

    await app.close();
  });

  it("dedup key clears on permanent failure — re-dispatch works", async () => {
    let callCount = 0;

    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("dedup-fail-clear", async () => {
      callCount++;
      if (callCount === 1) throw new Error("fail");
      return "ok";
    });

    const h1 = task.dispatch(
      {},
      {
        deduplicate: { key: "fail-key" },
      },
    );
    await h1;

    await app.start();

    // Wait for failure
    await waitFor(async () => {
      const state = await h1.getState();
      return state === "failed";
    });

    // Wait a tick for dedup key cleanup
    await new Promise((r) => setTimeout(r, 100));

    // Should be able to re-dispatch
    const h2 = task.dispatch(
      {},
      {
        deduplicate: { key: "fail-key" },
      },
    );
    await h2;
    expect(h2.enqueued).toBe(true);

    await app.close();
  });
});

// ── Priority ───────────────────────────────────────────────────────
//
// Since wireVersion 5 the wait queue is split: priority=0 jobs live in
// a LIST at `:wait` (FIFO, O(1) RPOP fast path), priority>0 jobs live
// in a separate ZSET at `:prioritized` (score = `-priority * 1e13 + ts`).
// Dequeue always drains the LIST first and only falls back to the ZSET
// when the LIST is empty. This restores BullMQ-style O(1) dequeue on
// the common (non-priority) path.
//
// The guarantees:
//   • Within the prioritized ZSET, higher priority still comes first.
//     FIFO holds within one priority band (same-millisecond ties fall
//     back to ZSET lex order on the UUID member, which is
//     effectively random — documented caveat, not a regression).
//   • The wait LIST is strict FIFO (RPOP from the tail, LPUSH at the
//     head).
//   • Cross-queue ordering is NOT strict priority. A priority=0 job
//     already in the LIST dispatches BEFORE a later priority=5 job,
//     because the LIST is checked first. Users relying on strict
//     cross-queue priority must either use only priority>0 or drain
//     the LIST before dispatching priority work.
//
// With concurrency > 1, multiple workers pop and finish jobs in
// parallel, so even a perfectly sorted prioritized ZSET does not
// translate into a deterministic execution order. The tests below
// run at concurrency 1 so the observable order matches dequeue order.

describe("priority", () => {
  it("within the prioritized band, higher priority dispatches first (Redis)", async () => {
    const processed: number[] = [];

    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("priority-basic", {
      concurrency: 1,
      handler: async (data: { n: number }) => {
        processed.push(data.n);
      },
    });

    // All priority > 0 — these all land in the prioritized ZSET, the
    // non-priority LIST stays empty, so strict priority ordering holds.
    await Promise.all([
      task.dispatch({ n: 1 }, { priority: 1 }).ensureEnqueued(),
      task.dispatch({ n: 5 }, { priority: 5 }).ensureEnqueued(),
      task.dispatch({ n: 10 }, { priority: 10 }).ensureEnqueued(),
    ]);

    // Wait LIST must be empty (or missing), prioritized ZSET holds all 3.
    const waitType = await redis.type("taskora:{priority-basic}:wait");
    expect(["none", "list"]).toContain(waitType);
    const waitLen = waitType === "list" ? await redis.llen("taskora:{priority-basic}:wait") : 0;
    expect(waitLen).toBe(0);
    const prioritizedType = await redis.type("taskora:{priority-basic}:prioritized");
    expect(prioritizedType).toBe("zset");
    const prioritizedCount = await redis.zcard("taskora:{priority-basic}:prioritized");
    expect(prioritizedCount).toBe(3);

    await app.start();
    await waitFor(() => processed.length === 3);

    expect(processed).toEqual([10, 5, 1]);

    await app.close();
  });

  it("wait LIST drains before the prioritized ZSET is consulted (Redis)", async () => {
    const processed: number[] = [];

    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("priority-split", {
      concurrency: 1,
      handler: async (data: { n: number }) => {
        processed.push(data.n);
      },
    });

    // Enqueue one priority=0 job first, then higher-priority jobs.
    // The wireVersion-5 layout pops the LIST before the ZSET, so n=0
    // comes out BEFORE the priority=10 jobs even though priority is
    // higher.
    await task.dispatch({ n: 0 }, { priority: 0 }).ensureEnqueued();
    await task.dispatch({ n: 10 }, { priority: 10 }).ensureEnqueued();
    await task.dispatch({ n: 5 }, { priority: 5 }).ensureEnqueued();

    expect(await redis.type("taskora:{priority-split}:wait")).toBe("list");
    expect(await redis.llen("taskora:{priority-split}:wait")).toBe(1);
    expect(await redis.zcard("taskora:{priority-split}:prioritized")).toBe(2);

    await app.start();
    await waitFor(() => processed.length === 3);

    // n=0 (from LIST) first, then 10 and 5 from prioritized ZSET in
    // priority DESC order.
    expect(processed).toEqual([0, 10, 5]);

    await app.close();
  });

  it("priority=0 jobs dispatch FIFO through the wait LIST (Redis)", async () => {
    const processed: number[] = [];

    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("priority-fifo", {
      concurrency: 1,
      handler: async (data: { n: number }) => {
        processed.push(data.n);
      },
    });

    // Enqueue 5 priority=0 jobs sequentially — order must survive.
    for (let i = 0; i < 5; i++) {
      await task.dispatch({ n: i }).ensureEnqueued();
    }

    expect(await redis.type("taskora:{priority-fifo}:wait")).toBe("list");
    expect(await redis.llen("taskora:{priority-fifo}:wait")).toBe(5);

    await app.start();
    await waitFor(() => processed.length === 5);

    expect(processed).toEqual([0, 1, 2, 3, 4]);

    await app.close();
  });
});
