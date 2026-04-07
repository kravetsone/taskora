import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTaskora } from "../../src/index.js";
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

// ── Task-level events ─────────────────────────────────────────────

describe("task events", () => {
  it("emits 'completed' with typed result", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const events: Array<{
      id: string;
      result: { ok: boolean };
      duration: number;
      attempt: number;
    }> = [];

    const sendEmail = app.task<{ to: string }, { ok: boolean }>("send-email", async () => {
      return { ok: true };
    });

    sendEmail.on("completed", (event) => {
      events.push(event);
    });

    sendEmail.dispatch({ to: "alice@example.com" });
    await app.start();

    await waitFor(() => events.length === 1);

    expect(events[0].result).toEqual({ ok: true });
    expect(events[0].attempt).toBe(1);
    expect(typeof events[0].id).toBe("string");
    expect(events[0].duration).toBeGreaterThanOrEqual(0);

    await app.close();
  });

  it("emits 'failed' on permanent failure", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const events: Array<{ id: string; error: string; willRetry: boolean }> = [];

    const failing = app.task("failing", async () => {
      throw new Error("boom");
    });

    failing.on("failed", (event) => {
      events.push(event);
    });

    failing.dispatch({});
    await app.start();

    await waitFor(() => events.length === 1);

    expect(events[0].error).toBe("boom");
    expect(events[0].willRetry).toBe(false);

    await app.close();
  });

  it("emits 'failed' with willRetry=true and 'retrying' on retry", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const failedEvents: Array<{ willRetry: boolean; attempt: number }> = [];
    const retryingEvents: Array<{ attempt: number; nextAttempt: number; error: string }> = [];

    let callCount = 0;
    const retryTask = app.task("retry-task", {
      retry: { attempts: 2, delay: 100 },
      handler: async () => {
        callCount++;
        if (callCount === 1) throw new Error("first try fails");
        return "ok";
      },
    });

    retryTask.on("failed", (event) => {
      failedEvents.push(event);
    });
    retryTask.on("retrying", (event) => {
      retryingEvents.push(event);
    });

    retryTask.dispatch({});
    await app.start();

    await waitFor(() => retryingEvents.length === 1);

    expect(failedEvents.length).toBeGreaterThanOrEqual(1);
    expect(failedEvents[0].willRetry).toBe(true);

    expect(retryingEvents[0].error).toBe("first try fails");
    expect(retryingEvents[0].attempt).toBe(2);
    expect(retryingEvents[0].nextAttempt).toBeGreaterThan(0);

    await app.close();
  });

  it("emits 'active' when job starts processing", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const events: Array<{ id: string; attempt: number }> = [];

    const myTask = app.task("active-task", async () => "done");

    myTask.on("active", (event) => {
      events.push(event);
    });

    myTask.dispatch({});
    await app.start();

    await waitFor(() => events.length === 1);

    expect(events[0].attempt).toBe(1);
    expect(typeof events[0].id).toBe("string");

    await app.close();
  });

  it("emits 'progress' when handler reports progress", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const events: Array<{ id: string; progress: number | Record<string, unknown> }> = [];

    const myTask = app.task("progress-task", async (_data, ctx) => {
      ctx.progress(50);
      ctx.progress(100);
      return "done";
    });

    myTask.on("progress", (event) => {
      events.push(event);
    });

    myTask.dispatch({});
    await app.start();

    await waitFor(() => events.length >= 2);

    expect(events.some((e) => e.progress === 50)).toBe(true);
    expect(events.some((e) => e.progress === 100)).toBe(true);

    await app.close();
  });
});

// ── App-level events ────────���─────────────────────────────────────

describe("app events", () => {
  it("emits 'task:completed' for any task", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const events: Array<{ task: string; id: string }> = [];

    app.on("task:completed", (event) => {
      events.push(event);
    });

    const t1 = app.task<unknown, string>("task-a", async () => "a");
    const t2 = app.task<unknown, string>("task-b", async () => "b");

    t1.dispatch({});
    t2.dispatch({});
    await app.start();

    await waitFor(() => events.length === 2);

    const taskNames = events.map((e) => e.task).sort();
    expect(taskNames).toEqual(["task-a", "task-b"]);

    await app.close();
  });

  it("emits 'task:failed' for any task failure", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const events: Array<{ task: string; error: string }> = [];

    app.on("task:failed", (event) => {
      events.push(event);
    });

    const failing = app.task("fail-app", async () => {
      throw new Error("oops");
    });

    failing.dispatch({});
    await app.start();

    await waitFor(() => events.length === 1);

    expect(events[0].task).toBe("fail-app");
    expect(events[0].error).toBe("oops");

    await app.close();
  });

  it("emits 'task:active' when job starts processing", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const events: Array<{ task: string; id: string }> = [];

    app.on("task:active", (event) => {
      events.push(event);
    });

    const t = app.task("active-app", async () => "done");

    t.dispatch({});
    await app.start();

    await waitFor(() => events.length === 1);

    expect(events[0].task).toBe("active-app");

    await app.close();
  });

  it("emits 'worker:ready' on start", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    let ready = false;

    app.on("worker:ready", () => {
      ready = true;
    });

    app.task("noop", async () => {});
    await app.start();

    expect(ready).toBe(true);

    await app.close();
  });

  it("emits 'worker:closing' on close", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    let closing = false;

    app.on("worker:closing", () => {
      closing = true;
    });

    app.task("noop", async () => {});
    await app.start();
    await app.close();

    expect(closing).toBe(true);
  });
});

// ── Edge cases ────────────────────────────────────────────────────

describe("event edge cases", () => {
  it("unsubscribe removes handler", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const events: string[] = [];

    const myTask = app.task<unknown, string>("unsub-task", async () => "done");

    const unsub = myTask.on("completed", () => {
      events.push("should-not-appear-after-unsub");
    });
    unsub();

    // Add a second listener to keep subscription alive
    myTask.on("completed", () => {
      events.push("second-listener");
    });

    myTask.dispatch({});
    await app.start();

    await waitFor(() => events.length === 1);

    expect(events).toEqual(["second-listener"]);

    await app.close();
  });

  it("default error logger fires when no failed listener is registered", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });

    const failing = app.task("default-log", async () => {
      throw new Error("unhandled boom");
    });

    // No .on("failed") — default logger should fire
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    failing.dispatch({});
    await app.start();

    await waitFor(() => errorSpy.mock.calls.length >= 1);

    const output = errorSpy.mock.calls[0][0] as string;
    expect(output).toContain('[taskora] task "default-log"');
    expect(output).toContain("failed (attempt 1)");
    expect(output).toContain("unhandled boom");
    // Stack trace included
    expect(output).toContain("at ");

    errorSpy.mockRestore();
    await app.close();
  });

  it("default error logger is suppressed when task.on('failed') is registered", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const failedEvents: Array<{ error: string }> = [];

    const failing = app.task("suppressed-log", async () => {
      throw new Error("handled boom");
    });

    // Register a user listener — should suppress default logging
    failing.on("failed", (ev) => failedEvents.push(ev));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    failing.dispatch({});
    await app.start();

    await waitFor(() => failedEvents.length >= 1);
    // Small grace period to ensure no default log fires
    await new Promise((r) => setTimeout(r, 100));

    expect(failedEvents[0].error).toBe("handled boom");
    // Default logger should NOT have fired
    const taskoraLogs = errorSpy.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("[taskora]"),
    );
    expect(taskoraLogs).toHaveLength(0);

    errorSpy.mockRestore();
    await app.close();
  });

  it("default error logger is suppressed when app.on('task:failed') is registered", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const appFailedEvents: Array<{ error: string }> = [];

    const failing = app.task("app-suppressed-log", async () => {
      throw new Error("app handled");
    });

    app.on("task:failed", (ev) => appFailedEvents.push(ev));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    failing.dispatch({});
    await app.start();

    await waitFor(() => appFailedEvents.length >= 1);
    await new Promise((r) => setTimeout(r, 100));

    expect(appFailedEvents[0].error).toBe("app handled");
    const taskoraLogs = errorSpy.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("[taskora]"),
    );
    expect(taskoraLogs).toHaveLength(0);

    errorSpy.mockRestore();
    await app.close();
  });

  it("default error logger shows retry info", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });

    app.task("retry-log", {
      retry: { attempts: 3, delay: 50 },
      handler: async () => {
        throw new Error("retry me");
      },
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const task = (app as any).tasks.get("retry-log");
    task.dispatch({});
    await app.start();

    // Wait for first attempt + retry
    await waitFor(() => errorSpy.mock.calls.length >= 1);

    const firstLog = errorSpy.mock.calls[0][0] as string;
    expect(firstLog).toContain("attempt 1/3, will retry");

    // Wait for final failure
    await waitFor(() => {
      return errorSpy.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes("attempt 3/3)"),
      );
    }, 10_000);

    const finalLog = errorSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("attempt 3/3)"),
    )?.[0] as string;
    // Final failure — no "will retry"
    expect(finalLog).not.toContain("will retry");

    errorSpy.mockRestore();
    await app.close();
  });

  it("task.on() called after app.start() still works", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const events: Array<{ id: string }> = [];

    const myTask = app.task<unknown, string>("late-sub", async () => "done");

    await app.start();

    myTask.on("completed", (event) => {
      events.push(event);
    });

    // Small delay to let subscription start
    await new Promise((r) => setTimeout(r, 200));

    myTask.dispatch({});

    await waitFor(() => events.length === 1);

    expect(typeof events[0].id).toBe("string");

    await app.close();
  });
});
