import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DuplicateJobError, ThrottledError, createTaskora } from "../../src/index.js";
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
    expect(processed).toEqual([1, 2, 3]);

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
