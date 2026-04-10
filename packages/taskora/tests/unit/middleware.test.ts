import { describe, expect, it } from "vitest";
import { compose } from "../../src/middleware.js";
import type { Taskora } from "../../src/types.js";

function makeCtx(overrides?: Partial<Taskora.MiddlewareContext>): Taskora.MiddlewareContext {
  return {
    id: "test-id",
    attempt: 1,
    timestamp: Date.now(),
    signal: new AbortController().signal,
    heartbeat: () => {},
    retry: () => {
      throw new Error("not implemented");
    },
    progress: () => {},
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    task: { name: "test-task" },
    data: { input: true },
    result: undefined,
    ...overrides,
  };
}

describe("compose", () => {
  it("executes middleware in onion order", async () => {
    const order: string[] = [];

    const mw1: Taskora.Middleware = async (_ctx, next) => {
      order.push("mw1:enter");
      await next();
      order.push("mw1:exit");
    };

    const mw2: Taskora.Middleware = async (_ctx, next) => {
      order.push("mw2:enter");
      await next();
      order.push("mw2:exit");
    };

    const handler: Taskora.Middleware = async () => {
      order.push("handler");
    };

    const fn = compose([mw1, mw2, handler]);
    await fn(makeCtx());

    expect(order).toEqual(["mw1:enter", "mw2:enter", "handler", "mw2:exit", "mw1:exit"]);
  });

  it("propagates errors from middleware", async () => {
    const mw: Taskora.Middleware = async () => {
      throw new Error("middleware boom");
    };

    const fn = compose([mw]);
    await expect(fn(makeCtx())).rejects.toThrow("middleware boom");
  });

  it("propagates errors from downstream through upstream", async () => {
    const caught: string[] = [];

    const outer: Taskora.Middleware = async (_ctx, next) => {
      try {
        await next();
      } catch (err) {
        caught.push((err as Error).message);
        throw err;
      }
    };

    const inner: Taskora.Middleware = async () => {
      throw new Error("inner boom");
    };

    const fn = compose([outer, inner]);
    await expect(fn(makeCtx())).rejects.toThrow("inner boom");
    expect(caught).toEqual(["inner boom"]);
  });

  it("middleware can swallow errors", async () => {
    const outer: Taskora.Middleware = async (ctx, next) => {
      try {
        await next();
      } catch {
        ctx.result = "fallback";
      }
    };

    const inner: Taskora.Middleware = async () => {
      throw new Error("boom");
    };

    const ctx = makeCtx();
    const fn = compose([outer, inner]);
    await fn(ctx);
    expect(ctx.result).toBe("fallback");
  });

  it("rejects if next() is called multiple times", async () => {
    const mw: Taskora.Middleware = async (_ctx, next) => {
      await next();
      await next();
    };

    const fn = compose([mw, async () => {}]);
    await expect(fn(makeCtx())).rejects.toThrow("next() called multiple times");
  });

  it("works with empty middleware array", async () => {
    const fn = compose([]);
    const ctx = makeCtx();
    await fn(ctx);
    // Should complete without error
  });

  it("allows middleware to read and modify ctx.data", async () => {
    const transform: Taskora.Middleware = async (ctx, next) => {
      ctx.data = { ...(ctx.data as Record<string, unknown>), injected: true };
      await next();
    };

    const handler: Taskora.Middleware = async (ctx) => {
      ctx.result = ctx.data;
    };

    const ctx = makeCtx({ data: { original: true } });
    const fn = compose([transform, handler]);
    await fn(ctx);

    expect(ctx.result).toEqual({ original: true, injected: true });
  });

  it("allows middleware to read and modify ctx.result after next()", async () => {
    const wrapper: Taskora.Middleware = async (ctx, next) => {
      await next();
      ctx.result = { wrapped: true, inner: ctx.result };
    };

    const handler: Taskora.Middleware = async (ctx) => {
      ctx.result = "hello";
    };

    const ctx = makeCtx();
    const fn = compose([wrapper, handler]);
    await fn(ctx);

    expect(ctx.result).toEqual({ wrapped: true, inner: "hello" });
  });

  it("middleware has access to task name", async () => {
    let taskName: string | undefined;

    const mw: Taskora.Middleware = async (ctx, next) => {
      taskName = ctx.task.name;
      await next();
    };

    const fn = compose([mw, async () => {}]);
    await fn(makeCtx({ task: { name: "my-task" } }));

    expect(taskName).toBe("my-task");
  });
});
