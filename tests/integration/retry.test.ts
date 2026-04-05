import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RetryError, taskora } from "../../src/index.js";
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

describe("retries", () => {
  it("job fails then succeeds on retry", async () => {
    let attempts = 0;

    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("retry-succeed", {
      retry: { attempts: 3, backoff: "fixed", delay: 100, jitter: false },
      handler: async (data: { value: number }) => {
        attempts++;
        if (attempts < 3) throw new Error(`fail #${attempts}`);
        return { result: data.value * 2 };
      },
    });

    const handle = task.dispatch({ value: 21 });
    await handle;
    await app.start();

    // Wait for the job to complete (it should fail twice, succeed on 3rd)
    const result = await handle.waitFor(15_000);
    expect(result).toEqual({ result: 42 });
    expect(attempts).toBe(3);

    // Verify state is completed
    const state = await handle.getState();
    expect(state).toBe("completed");

    await app.close();
  });

  it("exhausts all attempts then fails permanently", async () => {
    let attempts = 0;

    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("retry-exhaust", {
      retry: { attempts: 3, backoff: "fixed", delay: 100, jitter: false },
      handler: async () => {
        attempts++;
        throw new Error("always fails");
      },
    });

    const handle = task.dispatch({});
    const jobId = await handle;
    await app.start();

    await waitFor(async () => {
      const state = await handle.getState();
      return state === "failed";
    });

    expect(attempts).toBe(3); // 3 total attempts
    const error = await redis.hget(`taskora:{retry-exhaust}:${jobId}`, "error");
    expect(error).toBe("always fails");

    await app.close();
  });

  it("ctx.retry() overrides backoff delay", async () => {
    let attempts = 0;

    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("ctx-retry", {
      retry: { attempts: 3, backoff: "exponential", delay: 10_000, jitter: false },
      handler: async (_data: unknown, ctx) => {
        attempts++;
        if (attempts === 1) {
          // Override the 10s delay with 100ms
          throw ctx.retry({ delay: 100, reason: "rate limited" });
        }
        return "done";
      },
    });

    const handle = task.dispatch({});
    await handle;
    await app.start();

    // Should complete quickly because ctx.retry overrode the 10s delay
    const result = await handle.waitFor(5_000);
    expect(result).toBe("done");
    expect(attempts).toBe(2);

    await app.close();
  });

  it("throw new RetryError() works same as ctx.retry()", async () => {
    let attempts = 0;

    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("raw-retry-error", {
      retry: { attempts: 3, backoff: "exponential", delay: 10_000, jitter: false },
      handler: async () => {
        attempts++;
        if (attempts === 1) {
          throw new RetryError({ delay: 100, message: "manual retry" });
        }
        return "ok";
      },
    });

    const handle = task.dispatch({});
    await handle;
    await app.start();

    const result = await handle.waitFor(5_000);
    expect(result).toBe("ok");
    expect(attempts).toBe(2);

    await app.close();
  });

  it("noRetryOn: matching error goes straight to failed", async () => {
    class AuthError extends Error {
      constructor() {
        super("unauthorized");
        this.name = "AuthError";
      }
    }

    let attempts = 0;

    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("no-retry-on", {
      retry: { attempts: 5, backoff: "fixed", delay: 100, noRetryOn: [AuthError], jitter: false },
      handler: async () => {
        attempts++;
        throw new AuthError();
      },
    });

    const handle = task.dispatch({});
    const jobId = await handle;
    await app.start();

    await waitFor(async () => {
      const state = await handle.getState();
      return state === "failed";
    });

    // Should have only attempted once — no retry
    expect(attempts).toBe(1);

    await app.close();
  });

  it("retryOn: only matching errors trigger retry", async () => {
    class NetworkError extends Error {
      constructor() {
        super("network down");
        this.name = "NetworkError";
      }
    }

    let attempts = 0;

    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("retry-on", {
      retry: {
        attempts: 5,
        backoff: "fixed",
        delay: 100,
        retryOn: [NetworkError],
        jitter: false,
      },
      handler: async () => {
        attempts++;
        // Throw a non-matching error
        throw new Error("generic error");
      },
    });

    const handle = task.dispatch({});
    await handle;
    await app.start();

    await waitFor(async () => {
      const state = await handle.getState();
      return state === "failed";
    });

    // Non-matching error should not be retried
    expect(attempts).toBe(1);

    await app.close();
  });

  it("job without retry config fails immediately", async () => {
    let attempts = 0;

    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("no-retry", async () => {
      attempts++;
      throw new Error("fail");
    });

    const handle = task.dispatch({});
    await handle;
    await app.start();

    await waitFor(async () => {
      const state = await handle.getState();
      return state === "failed";
    });

    expect(attempts).toBe(1);
    await app.close();
  });

  it("stores maxAttempts in job hash for observability", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("observe-max", {
      retry: { attempts: 5, backoff: "fixed", delay: 100, jitter: false },
      handler: async () => "ok",
    });

    const handle = task.dispatch({});
    const jobId = await handle;

    const maxAttempts = await redis.hget(`taskora:{observe-max}:${jobId}`, "maxAttempts");
    expect(maxAttempts).toBe("5");

    await app.close();
  });

  it("retrying state transitions correctly", async () => {
    let attempts = 0;
    const states: string[] = [];

    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("state-transitions", {
      retry: { attempts: 2, backoff: "fixed", delay: 200, jitter: false },
      handler: async () => {
        attempts++;
        if (attempts === 1) throw new Error("fail once");
        return "done";
      },
    });

    const handle = task.dispatch({});
    const jobId = await handle;
    await app.start();

    // Poll for retrying state
    await waitFor(async () => {
      const s = await handle.getState();
      if (s && !states.includes(s)) states.push(s);
      return s === "completed";
    });

    expect(states).toContain("retrying");
    expect(states).toContain("completed");

    await app.close();
  });
});
