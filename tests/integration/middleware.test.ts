import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { taskora } from "../../src/index.js";
import { redisAdapter } from "../../src/redis/index.js";
import type { Taskora } from "../../src/types.js";
import { url, waitFor } from "../helpers.js";

let redis: Redis;

beforeEach(() => {
  redis = new Redis(url());
});

afterEach(async () => {
  await redis.flushdb();
  await redis.quit();
});

describe("middleware", () => {
  it("app-level middleware wraps all tasks", async () => {
    const calls: string[] = [];

    const app = taskora({ adapter: redisAdapter(url()) });

    app.use(async (ctx, next) => {
      calls.push(`mw:${ctx.task.name}:enter`);
      await next();
      calls.push(`mw:${ctx.task.name}:exit`);
    });

    const taskA = app.task("task-a", async () => {
      calls.push("handler:task-a");
      return "a";
    });

    const taskB = app.task("task-b", async () => {
      calls.push("handler:task-b");
      return "b";
    });

    taskA.dispatch(null);
    taskB.dispatch(null);

    await app.start();
    await waitFor(() => calls.length === 6);

    // Both tasks should be wrapped by app middleware
    expect(calls).toContain("mw:task-a:enter");
    expect(calls).toContain("handler:task-a");
    expect(calls).toContain("mw:task-a:exit");
    expect(calls).toContain("mw:task-b:enter");
    expect(calls).toContain("handler:task-b");
    expect(calls).toContain("mw:task-b:exit");

    await app.close();
  });

  it("per-task middleware only wraps that task", async () => {
    const calls: string[] = [];

    const taskMw: Taskora.Middleware = async (ctx, next) => {
      calls.push(`task-mw:${ctx.task.name}`);
      await next();
    };

    const app = taskora({ adapter: redisAdapter(url()) });

    const withMw = app.task("with-mw", {
      middleware: [taskMw],
      handler: async () => {
        calls.push("handler:with-mw");
        return "ok";
      },
    });

    const withoutMw = app.task("without-mw", async () => {
      calls.push("handler:without-mw");
      return "ok";
    });

    withMw.dispatch(null);
    withoutMw.dispatch(null);

    await app.start();
    await waitFor(() => calls.length === 3);

    expect(calls).toContain("task-mw:with-mw");
    expect(calls).toContain("handler:with-mw");
    expect(calls).toContain("handler:without-mw");
    // Task middleware should NOT have been called for without-mw
    expect(calls.filter((c) => c.startsWith("task-mw:"))).toHaveLength(1);

    await app.close();
  });

  it("execution order: app middleware → task middleware → handler", async () => {
    const order: string[] = [];

    const app = taskora({ adapter: redisAdapter(url()) });

    app.use(async (_ctx, next) => {
      order.push("app-mw:enter");
      await next();
      order.push("app-mw:exit");
    });

    const myTask = app.task("ordered", {
      middleware: [
        async (_ctx, next) => {
          order.push("task-mw:enter");
          await next();
          order.push("task-mw:exit");
        },
      ],
      handler: async () => {
        order.push("handler");
        return "done";
      },
    });

    myTask.dispatch(null);

    await app.start();
    await waitFor(() => order.length === 5);

    expect(order).toEqual([
      "app-mw:enter",
      "task-mw:enter",
      "handler",
      "task-mw:exit",
      "app-mw:exit",
    ]);

    await app.close();
  });

  it("middleware can access and modify ctx.data", async () => {
    let handlerData: unknown;

    const app = taskora({ adapter: redisAdapter(url()) });

    app.use(async (ctx, next) => {
      ctx.data = { ...(ctx.data as Record<string, unknown>), enriched: true };
      await next();
    });

    const myTask = app.task("enrich", async (data: { value: number; enriched?: boolean }) => {
      handlerData = data;
      return "ok";
    });

    myTask.dispatch({ value: 42 });

    await app.start();
    await waitFor(() => handlerData !== undefined);

    expect(handlerData).toEqual({ value: 42, enriched: true });

    await app.close();
  });

  it("middleware can read ctx.result after next()", async () => {
    let capturedResult: unknown;

    const app = taskora({ adapter: redisAdapter(url()) });

    app.use(async (ctx, next) => {
      await next();
      capturedResult = ctx.result;
    });

    const myTask = app.task("result-read", async () => {
      return { answer: 42 };
    });

    myTask.dispatch(null);

    await app.start();
    await waitFor(() => capturedResult !== undefined);

    expect(capturedResult).toEqual({ answer: 42 });

    await app.close();
  });

  it("middleware can modify ctx.result (transform output)", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });
    const results: unknown[] = [];

    app.use(async (ctx, next) => {
      await next();
      ctx.result = { wrapped: true, inner: ctx.result };
    });

    const myTask = app.task("transform", async () => {
      return "raw";
    });

    myTask.on("completed", (event) => {
      results.push(event.result);
    });

    myTask.dispatch(null);

    await app.start();
    await waitFor(() => results.length === 1);

    // The stored result should be the transformed one
    expect(results[0]).toEqual({ wrapped: true, inner: "raw" });

    await app.close();
  });

  it("middleware error propagates and fails the job", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });
    const errors: string[] = [];

    app.use(async () => {
      throw new Error("middleware error");
    });

    const myTask = app.task("mw-fail", async () => {
      return "should not reach";
    });

    myTask.on("failed", (event) => {
      errors.push(event.error);
    });

    myTask.dispatch(null);

    await app.start();
    await waitFor(() => errors.length === 1);

    expect(errors[0]).toBe("middleware error");

    await app.close();
  });

  it("middleware has access to ctx.id, ctx.attempt, ctx.task.name", async () => {
    let captured: { id: string; attempt: number; taskName: string } | undefined;

    const app = taskora({ adapter: redisAdapter(url()) });

    app.use(async (ctx, next) => {
      captured = {
        id: ctx.id,
        attempt: ctx.attempt,
        taskName: ctx.task.name,
      };
      await next();
    });

    const myTask = app.task("ctx-check", async () => "ok");
    const handle = myTask.dispatch(null);
    const jobId = await handle;

    await app.start();
    await waitFor(() => captured !== undefined);

    expect(captured).toBeDefined();
    expect(captured?.id).toBe(jobId);
    expect(captured?.attempt).toBe(1);
    expect(captured?.taskName).toBe("ctx-check");

    await app.close();
  });

  it("cannot add middleware after app.start()", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });
    app.task("dummy", async () => "ok");

    await app.start();

    expect(() => app.use(async (_ctx, next) => next())).toThrow(
      "Cannot add middleware after app.start()",
    );

    await app.close();
  });

  it("multiple app middleware execute in registration order", async () => {
    const order: number[] = [];

    const app = taskora({ adapter: redisAdapter(url()) });

    app.use(async (_ctx, next) => {
      order.push(1);
      await next();
    });
    app.use(async (_ctx, next) => {
      order.push(2);
      await next();
    });
    app.use(async (_ctx, next) => {
      order.push(3);
      await next();
    });

    const myTask = app.task("multi-mw", async () => "ok");
    myTask.dispatch(null);

    await app.start();
    await waitFor(() => order.length === 3);

    expect(order).toEqual([1, 2, 3]);

    await app.close();
  });
});
