import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

// ── Collect — debounce + accumulation ─────────────────────────────

describe("collect", () => {
  it("accumulates dispatches and flushes after delay", async () => {
    const batches: Array<Array<{ n: number }>> = [];

    const app = taskora({ adapter: redisAdapter(url()) });
    const task = app.task<{ n: number }, void>("collect-basic", {
      collect: {
        key: "all",
        delay: "1s",
      },
      handler: async (items) => {
        batches.push(items);
      },
    });

    await app.start();

    // Dispatch 5 items rapidly
    for (let i = 1; i <= 5; i++) {
      await task.dispatch({ n: i });
    }

    // Wait for flush (1s debounce + processing time)
    await waitFor(() => batches.length === 1, 5000);

    expect(batches.length).toBe(1);
    expect(batches[0]).toHaveLength(5);
    expect(batches[0].map((x) => x.n)).toEqual([1, 2, 3, 4, 5]);

    await app.close();
  });

  it("dynamic key groups items separately", async () => {
    const batches: Array<Array<{ group: string; n: number }>> = [];

    const app = taskora({ adapter: redisAdapter(url()) });
    const task = app.task<{ group: string; n: number }, void>("collect-key", {
      collect: {
        key: (d) => d.group,
        delay: "1s",
      },
      handler: async (items) => {
        batches.push(items);
      },
    });

    await app.start();

    await task.dispatch({ group: "a", n: 1 });
    await task.dispatch({ group: "b", n: 2 });
    await task.dispatch({ group: "a", n: 3 });
    await task.dispatch({ group: "b", n: 4 });

    await waitFor(() => batches.length === 2, 5000);

    // Two batches — one per group
    const groupA = batches.find((b) => b[0].group === "a");
    const groupB = batches.find((b) => b[0].group === "b");

    expect(groupA).toHaveLength(2);
    expect(groupA?.map((x) => x.n)).toEqual([1, 3]);
    expect(groupB).toHaveLength(2);
    expect(groupB?.map((x) => x.n)).toEqual([2, 4]);

    await app.close();
  });

  it("maxSize triggers immediate flush before delay", async () => {
    const batches: Array<Array<{ n: number }>> = [];

    const app = taskora({ adapter: redisAdapter(url()) });
    const task = app.task<{ n: number }, void>("collect-maxsize", {
      collect: {
        key: "all",
        delay: "30s", // long delay — should NOT wait for this
        maxSize: 3,
      },
      handler: async (items) => {
        batches.push(items);
      },
    });

    await app.start();

    // Dispatch exactly maxSize items
    for (let i = 1; i <= 3; i++) {
      await task.dispatch({ n: i });
    }

    // Should flush immediately (not wait 30s)
    await waitFor(() => batches.length === 1, 5000);

    expect(batches[0]).toHaveLength(3);
    expect(batches[0].map((x) => x.n)).toEqual([1, 2, 3]);

    await app.close();
  });

  it("maxWait caps the debounce window", async () => {
    const batches: Array<Array<{ n: number }>> = [];

    const app = taskora({ adapter: redisAdapter(url()) });
    const task = app.task<{ n: number }, void>("collect-maxwait", {
      collect: {
        key: "all",
        delay: "30s", // long debounce — keeps resetting
        maxWait: "2s", // but maxWait forces flush after 2s from first item
      },
      handler: async (items) => {
        batches.push(items);
      },
    });

    await app.start();

    // Dispatch items with short intervals to keep debounce resetting
    for (let i = 1; i <= 3; i++) {
      await task.dispatch({ n: i });
      if (i < 3) await new Promise((r) => setTimeout(r, 500));
    }

    // maxWait=2s should force flush even though debounce keeps resetting
    await waitFor(() => batches.length === 1, 6000);

    expect(batches[0]).toHaveLength(3);
    expect(batches[0].map((x) => x.n)).toEqual([1, 2, 3]);

    await app.close();
  });

  it("failed batch retries as one job — no data loss", async () => {
    let attempts = 0;
    const batches: Array<Array<{ n: number }>> = [];

    const app = taskora({ adapter: redisAdapter(url()) });
    const task = app.task<{ n: number }, void>("collect-retry", {
      collect: {
        key: "all",
        delay: "1s",
        maxSize: 3,
      },
      retry: { attempts: 3, backoff: "fixed", delay: 500 },
      handler: async (items) => {
        attempts++;
        if (attempts === 1) {
          throw new Error("transient failure");
        }
        batches.push(items);
      },
    });

    await app.start();

    for (let i = 1; i <= 3; i++) {
      await task.dispatch({ n: i });
    }

    // First attempt fails, second succeeds — same batch of 3 items
    await waitFor(() => batches.length === 1, 10_000);

    expect(attempts).toBe(2);
    expect(batches[0]).toHaveLength(3);
    expect(batches[0].map((x) => x.n)).toEqual([1, 2, 3]);

    await app.close();
  });
});
