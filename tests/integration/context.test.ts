import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobFailedError, TimeoutError, taskora } from "../../src/index.js";
import { redisAdapter } from "../../src/redis/index.js";

let redis: Redis;

function url() {
  const u = process.env.REDIS_URL;
  if (!u) throw new Error("REDIS_URL not set");
  return u;
}

beforeEach(() => {
  redis = new Redis(url());
});

afterEach(async () => {
  await redis.flushdb();
  await redis.quit();
});

async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 10_000, interval = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("ctx.progress", () => {
  it("reports numeric progress visible via handle.getProgress()", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("progress-num", {
      handler: async (_data: unknown, ctx) => {
        ctx.progress(25);
        // small delay so the fire-and-forget write lands
        await new Promise((r) => setTimeout(r, 50));
        ctx.progress(75);
        await new Promise((r) => setTimeout(r, 50));
        return "done";
      },
    });

    const handle = task.dispatch({});
    await handle;
    await app.start();

    const result = await handle.waitFor(10_000);
    expect(result).toBe("done");

    const progress = await handle.getProgress();
    expect(progress).toBe(75);

    await app.close();
  });

  it("reports object progress visible via handle.getProgress()", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("progress-obj", {
      handler: async (_data: unknown, ctx) => {
        ctx.progress({ step: "uploading", percent: 50 });
        await new Promise((r) => setTimeout(r, 50));
        return "done";
      },
    });

    const handle = task.dispatch({});
    await handle;
    await app.start();

    await handle.waitFor(10_000);

    const progress = await handle.getProgress();
    expect(progress).toEqual({ step: "uploading", percent: 50 });

    await app.close();
  });

  it("returns null when no progress reported", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("progress-none", {
      handler: async () => "done",
    });

    const handle = task.dispatch({});
    await handle;
    await app.start();

    await handle.waitFor(10_000);

    const progress = await handle.getProgress();
    expect(progress).toBeNull();

    await app.close();
  });
});

describe("ctx.log", () => {
  it("logs queryable via handle.getLogs()", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("log-test", {
      handler: async (_data: unknown, ctx) => {
        ctx.log.info("Starting work");
        ctx.log.warn("Rate limit approaching", { remaining: 3 });
        ctx.log.error("Something went wrong", { code: 500 });
        // Allow fire-and-forget writes to complete
        await new Promise((r) => setTimeout(r, 100));
        return "done";
      },
    });

    const handle = task.dispatch({});
    await handle;
    await app.start();

    await handle.waitFor(10_000);

    const logs = await handle.getLogs();
    expect(logs).toHaveLength(3);

    expect(logs[0].level).toBe("info");
    expect(logs[0].message).toBe("Starting work");
    expect(logs[0].timestamp).toBeTypeOf("number");

    expect(logs[1].level).toBe("warn");
    expect(logs[1].message).toBe("Rate limit approaching");
    expect(logs[1].meta).toEqual({ remaining: 3 });

    expect(logs[2].level).toBe("error");
    expect(logs[2].message).toBe("Something went wrong");
    expect(logs[2].meta).toEqual({ code: 500 });

    await app.close();
  });

  it("returns empty array when no logs", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("log-empty", {
      handler: async () => "done",
    });

    const handle = task.dispatch({});
    await handle;
    await app.start();

    await handle.waitFor(10_000);

    const logs = await handle.getLogs();
    expect(logs).toEqual([]);

    await app.close();
  });
});

describe("timeout", () => {
  it("aborts handler and fails job when timeout expires", async () => {
    let signalAborted = false;

    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("timeout-task", {
      timeout: 200,
      handler: async (_data: unknown, ctx) => {
        ctx.signal.addEventListener("abort", () => {
          signalAborted = true;
        });
        // Simulate long work that exceeds timeout
        await new Promise((r) => setTimeout(r, 5_000));
        return "should not reach";
      },
    });

    const handle = task.dispatch({});
    const jobId = await handle;
    await app.start();

    await waitFor(async () => {
      const state = await handle.getState();
      return state === "failed";
    });

    expect(signalAborted).toBe(true);

    const error = await redis.hget(`taskora:{timeout-task}:${jobId}`, "error");
    expect(error).toContain("did not complete within 200ms");

    await app.close();
  });

  it("timeout errors are not retried by default", async () => {
    let attempts = 0;

    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("timeout-no-retry", {
      timeout: 100,
      retry: { attempts: 3, backoff: "fixed", delay: 100, jitter: false },
      handler: async () => {
        attempts++;
        await new Promise((r) => setTimeout(r, 5_000));
        return "nope";
      },
    });

    const handle = task.dispatch({});
    await handle;
    await app.start();

    await waitFor(async () => {
      const state = await handle.getState();
      return state === "failed";
    });

    // TimeoutError is not retried by default — only 1 attempt
    expect(attempts).toBe(1);

    await app.close();
  });

  it("handler that finishes before timeout succeeds normally", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("timeout-ok", {
      timeout: 5_000,
      handler: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return "fast";
      },
    });

    const handle = task.dispatch({});
    await handle;
    await app.start();

    const result = await handle.waitFor(10_000);
    expect(result).toBe("fast");

    await app.close();
  });
});

describe("ctx.signal on shutdown", () => {
  it("fires abort signal when app closes", async () => {
    let signalAborted = false;
    let handlerStarted = false;

    const app = taskora({ adapter: redisAdapter(url()) });

    app.task("signal-test", {
      handler: async (_data: unknown, ctx) => {
        handlerStarted = true;
        ctx.signal.addEventListener("abort", () => {
          signalAborted = true;
        });
        await new Promise((r) => setTimeout(r, 5_000));
        return null;
      },
    });

    const task = app.task("signal-dispatch", {
      handler: async (_data: unknown, ctx) => {
        handlerStarted = true;
        ctx.signal.addEventListener("abort", () => {
          signalAborted = true;
        });
        await new Promise((r) => setTimeout(r, 5_000));
        return null;
      },
    });

    task.dispatch({});
    await app.start();

    await waitFor(() => handlerStarted);
    await app.close({ timeout: 500 });

    expect(signalAborted).toBe(true);
  });
});
