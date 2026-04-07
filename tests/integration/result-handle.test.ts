import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobFailedError, TimeoutError, createTaskora } from "../../src/index.js";
import { redisAdapter } from "../../src/redis/index.js";
import { ResultHandle } from "../../src/result.js";
import { url, waitFor as poll } from "../helpers.js";

let redis: Redis;

beforeEach(() => {
  redis = new Redis(url());
});

afterEach(async () => {
  await redis.flushdb();
  await redis.quit();
});

// ── dispatch returns ResultHandle ────────────────────────────────────

describe("ResultHandle", () => {
  it("dispatch returns a ResultHandle synchronously", () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("sync-handle", async (data: { x: number }) => data.x * 2);

    const handle = task.dispatch({ x: 5 });
    expect(handle).toBeInstanceOf(ResultHandle);
    expect(typeof handle.id).toBe("string");
    expect(handle.id.length).toBe(36); // UUID v4 format

    // cleanup — ensure enqueue completes before closing
    handle.then(() => app.close());
  });

  it("await handle resolves to job id (ensures enqueued)", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("await-id", async () => "done");

    const handle = task.dispatch({});
    const id = await handle;

    expect(id).toBe(handle.id);
    expect(typeof id).toBe("string");

    // Verify job exists in Redis
    const state = await redis.hget(`taskora:{await-id}:${id}`, "state");
    expect(state).toBe("waiting");

    await app.close();
  });

  it("handle.result resolves to handler output", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("get-result", async (data: { n: number }) => ({
      doubled: data.n * 2,
    }));

    const handle = task.dispatch({ n: 21 });
    await app.start();

    const result = await handle.result;
    expect(result).toEqual({ doubled: 42 });

    await app.close();
  });

  it("handle.getState() returns correct state at each lifecycle point", async () => {
    let resolveHandler!: () => void;
    const handlerStarted = new Promise<void>((r) => {
      resolveHandler = r;
    });
    let finishHandler!: () => void;
    const handlerGate = new Promise<void>((r) => {
      finishHandler = r;
    });

    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("state-check", async () => {
      resolveHandler();
      await handlerGate;
      return "ok";
    });

    const handle = task.dispatch({});
    await handle; // ensure enqueued

    // State should be waiting before worker starts
    expect(await handle.getState()).toBe("waiting");

    await app.start();
    await handlerStarted;

    // State should be active while handler is running
    expect(await handle.getState()).toBe("active");

    // Let handler finish
    finishHandler();
    await poll(async () => (await handle.getState()) === "completed");

    expect(await handle.getState()).toBe("completed");

    await app.close();
  });

  it("handle.waitFor() throws TimeoutError on timeout", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("timeout-task", async () => {
      await new Promise((r) => setTimeout(r, 10_000));
      return null;
    });

    const handle = task.dispatch({});
    await app.start();

    await expect(handle.waitFor(200)).rejects.toThrow(TimeoutError);

    await app.close({ timeout: 100 });
  });

  it("handle.result rejects with JobFailedError for failed jobs", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("fail-result", async () => {
      throw new Error("something broke");
    });

    const handle = task.dispatch({});
    await app.start();

    try {
      await handle.result;
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(JobFailedError);
      const jobErr = err as JobFailedError;
      expect(jobErr.jobId).toBe(handle.id);
      expect(jobErr.taskName).toBe("fail-result");
      expect(jobErr.message).toBe("something broke");
    }

    await app.close();
  });

  it("works with Promise.all for multiple handles", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("promise-all", async (data: { n: number }) => data.n * 10);

    const handles = [task.dispatch({ n: 1 }), task.dispatch({ n: 2 }), task.dispatch({ n: 3 })];

    // Promise.all on handles ensures all enqueued
    const ids = await Promise.all(handles);
    expect(ids).toHaveLength(3);
    for (const id of ids) expect(typeof id).toBe("string");

    await app.start();

    // Promise.all on results
    const results = await Promise.all(handles.map((h) => h.result));
    expect(results.sort((a, b) => a - b)).toEqual([10, 20, 30]);

    await app.close();
  });

  it("dispatchMany returns ResultHandle array", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("bulk-handles", async (data: { name: string }) => ({
      greeting: `hi ${data.name}`,
    }));

    const handles = task.dispatchMany([{ data: { name: "a" } }, { data: { name: "b" } }]);

    expect(handles).toHaveLength(2);
    for (const h of handles) expect(h).toBeInstanceOf(ResultHandle);

    // Ensure all enqueued
    await Promise.all(handles);

    await app.start();

    const results = await Promise.all(handles.map((h) => h.result));
    expect(results).toContainEqual({ greeting: "hi a" });
    expect(results).toContainEqual({ greeting: "hi b" });

    await app.close();
  });

  it("delayed job handle tracks state through promotion", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("delayed-handle", async () => "delayed-done");

    const handle = task.dispatch({}, { delay: 300 });
    await handle; // ensure enqueued

    expect(await handle.getState()).toBe("delayed");

    await app.start();

    // Wait for completion (delay + processing)
    const result = await handle.waitFor(5_000);
    expect(result).toBe("delayed-done");
    expect(await handle.getState()).toBe("completed");

    await app.close();
  });

  it("getState returns null for non-existent job", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("phantom", async () => null);

    const handle = task.dispatch({});
    await handle;

    // Create a handle with a fake ID
    const fakeHandle = new ResultHandle<null>(
      "00000000-0000-0000-0000-000000000000",
      "phantom",
      app.adapter,
      app.serializer,
      Promise.resolve(),
    );

    expect(await fakeHandle.getState()).toBeNull();

    await app.close();
  });
});
