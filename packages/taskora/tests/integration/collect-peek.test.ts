import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskoraError } from "../../src/errors.js";
import { createTaskora } from "../../src/index.js";
import { memoryAdapter } from "../../src/memory/index.js";
import { redisAdapter } from "../create-adapter.js";
import { url, waitFor } from "../helpers.js";

// ── Peek API for collect buffers ──────────────────────────────────────
//
// These tests exercise the non-destructive read API (`peekCollect` /
// `inspectCollect`) against both the Redis adapter (atomic LRANGE / HGETALL
// snapshots) and the memory adapter (array slice / buffer meta). The goal is
// to pin down the semantic contract so future refactors can't silently
// weaken it:
//
//   1. Peek never drains and never resets the debounce timer.
//   2. The buffer → handler ownership boundary is preserved: once
//      moveToActive has drained the items list, peek returns empty.
//   3. A task without `collect` throws, rather than silently returning [].
//
// The Redis block uses a shared `app` per test case with a long `delay` so
// the flush sentinel stays pending — otherwise the buffer would race ahead
// of our assertions.

describe("collect peek (Redis)", () => {
  let redis: Redis;

  beforeEach(() => {
    redis = new Redis(url());
  });

  afterEach(async () => {
    await redis.flushdb();
    await redis.quit();
  });

  it("returns [] / null for an untouched key", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task<{ n: number }, void>("peek-empty", {
      collect: { key: "group", delay: "30s" },
      handler: async () => {},
    });

    await app.start();

    expect(await task.peekCollect("group")).toEqual([]);
    expect(await task.inspectCollect("group")).toBeNull();

    await app.close();
  });

  it("peek mid-accumulation returns items in dispatch order", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task<{ n: number }, void>("peek-accumulate", {
      // 30s debounce — no flush during the test window
      collect: { key: "all", delay: "30s" },
      handler: async () => {},
    });

    await app.start();

    for (let i = 1; i <= 4; i++) {
      await task.dispatch({ n: i });
    }

    const pending = await task.peekCollect("all");
    expect(pending).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);

    // inspectCollect mirrors peek count without reading payloads
    const info = await task.inspectCollect("all");
    expect(info).not.toBeNull();
    if (!info) throw new Error("unreachable");
    expect(info.count).toBe(4);
    expect(info.oldestAt).toBeLessThanOrEqual(info.newestAt);
    expect(info.newestAt).toBeLessThanOrEqual(Date.now() + 100);

    await app.close();
  });

  it("peek does not drain the buffer — dispatches keep accumulating", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task<{ n: number }, void>("peek-nondestructive", {
      collect: { key: "all", delay: "30s" },
      handler: async () => {},
    });

    await app.start();

    await task.dispatch({ n: 1 });
    await task.dispatch({ n: 2 });

    // Peek twice; second read should see the same buffer
    expect((await task.peekCollect("all")).length).toBe(2);
    expect((await task.peekCollect("all")).length).toBe(2);

    // More dispatches pile on top — peek does not reset anything
    await task.dispatch({ n: 3 });
    expect(await task.peekCollect("all")).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);

    await app.close();
  });

  it("peek returns [] once the handler has drained the buffer", async () => {
    const seen: Array<Array<{ n: number }>> = [];
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task<{ n: number }, void>("peek-after-flush", {
      // Short debounce so we can observe the flush within the test window.
      // `Duration` template literal only accepts `s`/`m`/`h`/`d` suffixes,
      // so use a raw-ms number for sub-second windows.
      collect: { key: "all", delay: 500 },
      handler: async (items) => {
        seen.push(items);
      },
    });

    await app.start();

    await task.dispatch({ n: 1 });
    await task.dispatch({ n: 2 });

    // Before flush: items are visible
    expect((await task.peekCollect("all")).length).toBe(2);

    // Wait for the debounce flush sentinel to fire and moveToActive to drain
    await waitFor(() => seen.length === 1, 5000);

    // After handler drained the buffer: peek sees empty, inspect sees null
    expect(await task.peekCollect("all")).toEqual([]);
    expect(await task.inspectCollect("all")).toBeNull();

    await app.close();
  });

  it("peek returns [] after a maxSize-triggered inline flush", async () => {
    const seen: Array<Array<{ n: number }>> = [];
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task<{ n: number }, void>("peek-maxsize", {
      collect: { key: "all", delay: "30s", maxSize: 3 },
      handler: async (items) => {
        seen.push(items);
      },
    });

    await app.start();

    await task.dispatch({ n: 1 });
    await task.dispatch({ n: 2 });
    // Third dispatch triggers inline flush inside COLLECT_PUSH Lua: the
    // accumulator list + meta hash + flush sentinel key are all DELed
    // atomically before the reply.
    await task.dispatch({ n: 3 });

    await waitFor(() => seen.length === 1, 5000);

    expect(await task.peekCollect("all")).toEqual([]);
    expect(await task.inspectCollect("all")).toBeNull();

    await app.close();
  });

  it("dynamic collect key — peek is scoped to the resolved key string", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task<{ group: string; n: number }, void>("peek-dynamic", {
      collect: { key: (d) => d.group, delay: "30s" },
      handler: async () => {},
    });

    await app.start();

    await task.dispatch({ group: "a", n: 1 });
    await task.dispatch({ group: "b", n: 2 });
    await task.dispatch({ group: "a", n: 3 });

    expect(await task.peekCollect("a")).toEqual([
      { group: "a", n: 1 },
      { group: "a", n: 3 },
    ]);
    expect(await task.peekCollect("b")).toEqual([{ group: "b", n: 2 }]);
    // Unknown key returns [] without error
    expect(await task.peekCollect("c")).toEqual([]);

    await app.close();
  });

  it("throws when called on a non-collect task", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task<{ n: number }, void>("peek-not-collect", {
      handler: async () => {},
    });

    await app.start();

    await expect(task.peekCollect("anything")).rejects.toBeInstanceOf(TaskoraError);
    await expect(task.inspectCollect("anything")).rejects.toBeInstanceOf(TaskoraError);

    await app.close();
  });
});

describe("collect peek (memory adapter)", () => {
  it("returns [] / null for an untouched key", async () => {
    const app = createTaskora({ adapter: memoryAdapter() });
    const task = app.task<{ n: number }, void>("mem-peek-empty", {
      collect: { key: "group", delay: "30s" },
      handler: async () => {},
    });
    await app.start();

    expect(await task.peekCollect("group")).toEqual([]);
    expect(await task.inspectCollect("group")).toBeNull();

    await app.close();
  });

  it("peek mid-accumulation returns deserialized items in order", async () => {
    const app = createTaskora({ adapter: memoryAdapter() });
    const task = app.task<{ n: number }, void>("mem-peek-accumulate", {
      collect: { key: "all", delay: "30s" },
      handler: async () => {},
    });
    await app.start();

    for (let i = 1; i <= 3; i++) {
      await task.dispatch({ n: i });
    }

    expect(await task.peekCollect("all")).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    const info = await task.inspectCollect("all");
    expect(info).not.toBeNull();
    if (!info) throw new Error("unreachable");
    expect(info.count).toBe(3);
    expect(info.oldestAt).toBeLessThanOrEqual(info.newestAt);

    await app.close();
  });

  it("returned array is a defensive copy — caller mutation does not leak", async () => {
    const app = createTaskora({ adapter: memoryAdapter() });
    const task = app.task<{ n: number }, void>("mem-peek-isolation", {
      collect: { key: "all", delay: "30s" },
      handler: async () => {},
    });
    await app.start();

    await task.dispatch({ n: 1 });
    const snapshot = await task.peekCollect("all");
    snapshot.length = 0;

    // Second peek is unaffected by the caller's mutation
    expect(await task.peekCollect("all")).toEqual([{ n: 1 }]);

    await app.close();
  });

  it("peek returns [] once the buffer is drained (adapter-level)", async () => {
    // Exercise the adapter directly rather than standing up a full worker
    // loop — memoryAdapter's blockingDequeue busy-polls (no real blocking),
    // which starves the event loop when combined with `waitFor`. The Redis
    // block above covers the full `collectPush → worker drain → peek returns []`
    // round trip; here we only need to confirm memoryAdapter honors the
    // "peek returns [] after buffer removal" contract, which is triggered
    // inline by the maxSize branch of collectPush itself.
    const adapter = memoryAdapter();
    await adapter.connect();

    await adapter.collectPush("mem-peek-maxsize", "j1", '{"n":1}', {
      _v: 1,
      collectKey: "all",
      delayMs: 30_000,
      maxSize: 2,
      maxWaitMs: 0,
    });
    // Mid-accumulation: buffer holds 1 item
    expect(await adapter.peekCollect("mem-peek-maxsize", "all")).toEqual(['{"n":1}']);
    expect((await adapter.inspectCollect("mem-peek-maxsize", "all"))?.count).toBe(1);

    // Second push hits maxSize → inline flush drains the buffer
    const result = await adapter.collectPush("mem-peek-maxsize", "j2", '{"n":2}', {
      _v: 1,
      collectKey: "all",
      delayMs: 30_000,
      maxSize: 2,
      maxWaitMs: 0,
    });
    expect(result.flushed).toBe(true);

    // After the flush: peek / inspect see the empty post-drain state
    expect(await adapter.peekCollect("mem-peek-maxsize", "all")).toEqual([]);
    expect(await adapter.inspectCollect("mem-peek-maxsize", "all")).toBeNull();

    await adapter.disconnect();
  });

  it("throws when called on a non-collect task", async () => {
    const app = createTaskora({ adapter: memoryAdapter() });
    const task = app.task<{ n: number }, void>("mem-peek-not-collect", {
      handler: async () => {},
    });
    await app.start();

    await expect(task.peekCollect("anything")).rejects.toBeInstanceOf(TaskoraError);
    await expect(task.inspectCollect("anything")).rejects.toBeInstanceOf(TaskoraError);

    await app.close();
  });
});
