import { describe, expect, it } from "vitest";
import { taskora } from "../../src/index.js";
import { memoryAdapter } from "../../src/memory/index.js";
import { createTestRunner } from "../../src/test/index.js";

describe("createTestRunner", () => {
  it("run() executes handler and returns result", async () => {
    const runner = createTestRunner();
    const task = runner.app.task("echo", async (data: { msg: string }) => ({
      reply: data.msg,
    }));

    const result = await runner.run(task, { msg: "hello" });
    expect(result).toEqual({ reply: "hello" });
  });

  it("run() loops through retries", async () => {
    const runner = createTestRunner();
    let attempts = 0;
    const flaky = runner.app.task("flaky", {
      retry: { attempts: 3, backoff: "fixed", delay: 100 },
      handler: async () => {
        attempts++;
        if (attempts < 3) throw new Error("not yet");
        return { ok: true };
      },
    });

    const result = await runner.run(flaky, {});
    expect(result).toEqual({ ok: true });
    expect(attempts).toBe(3);
  });

  it("run() throws on final failure", async () => {
    const runner = createTestRunner();
    const failing = runner.app.task("fail", {
      retry: { attempts: 2, backoff: "fixed", delay: 100 },
      handler: async () => {
        throw new Error("always fails");
      },
    });

    await expect(runner.run(failing, {})).rejects.toThrow("always fails");
  });

  it("run() with middleware", async () => {
    const runner = createTestRunner();
    const order: string[] = [];

    const task = runner.app.task("mw-test", {
      middleware: [
        async (ctx, next) => {
          order.push("before");
          await next();
          order.push("after");
        },
      ],
      handler: async () => {
        order.push("handler");
        return null;
      },
    });

    await runner.run(task, {});
    expect(order).toEqual(["before", "handler", "after"]);
  });

  it("dispatch() + processAll() processes non-delayed jobs", async () => {
    const runner = createTestRunner();
    const task = runner.app.task("work", async (data: { x: number }) => ({
      doubled: data.x * 2,
    }));

    const handle = runner.dispatch(task, { x: 5 });
    await handle; // wait for enqueue

    expect(await handle.getState()).toBe("waiting");
    await runner.processAll();
    expect(await handle.getState()).toBe("completed");
  });

  it("dispatch() with delay + advanceTime()", async () => {
    const runner = createTestRunner();
    const task = runner.app.task("delayed", async (data: { v: number }) => ({
      result: data.v,
    }));

    const handle = runner.dispatch(task, { v: 42 }, { delay: 5 * 60 * 1000 });
    await handle;

    expect(await handle.getState()).toBe("delayed");
    await runner.advanceTime("5m");
    expect(await handle.getState()).toBe("completed");
  });

  it("jobs property lists all jobs", async () => {
    const runner = createTestRunner();
    const task = runner.app.task("j", async () => "done");

    runner.dispatch(task, {});
    runner.dispatch(task, {});
    await new Promise((r) => setTimeout(r, 0)); // let enqueues settle

    expect(runner.jobs.length).toBe(2);
    expect(runner.jobs.every((j) => j.state === "waiting")).toBe(true);
  });

  it("clear() resets all state", async () => {
    const runner = createTestRunner();
    const task = runner.app.task("c", async () => null);

    runner.dispatch(task, {});
    await new Promise((r) => setTimeout(r, 0));
    expect(runner.jobs.length).toBe(1);

    runner.clear();
    expect(runner.jobs.length).toBe(0);
  });

  it("advanceTime processes retrying jobs after delay", async () => {
    const runner = createTestRunner();
    let attempts = 0;
    const task = runner.app.task("retry-queue", {
      retry: { attempts: 3, backoff: "fixed", delay: 1000, jitter: false },
      handler: async () => {
        attempts++;
        if (attempts < 3) throw new Error("fail");
        return { ok: true };
      },
    });

    const handle = runner.dispatch(task, {});
    await handle;

    // Process first attempt — fails, goes to delayed with 1s delay
    await runner.processAll();
    expect(await handle.getState()).toBe("retrying");

    // Advance 1s — promotes retrying job, processes second attempt — fails again
    await runner.advanceTime("1s");
    expect(await handle.getState()).toBe("retrying");

    // Advance 1s — third attempt succeeds
    await runner.advanceTime("1s");
    expect(await handle.getState()).toBe("completed");
    expect(attempts).toBe(3);
  });

  it("cancel() a waiting job", async () => {
    const runner = createTestRunner();
    const task = runner.app.task("cancel-test", async () => "done");

    const handle = runner.dispatch(task, {});
    await handle;
    expect(await handle.getState()).toBe("waiting");

    await handle.cancel({ reason: "no longer needed" });
    expect(await handle.getState()).toBe("cancelled");
  });

  it("inspector works with memory adapter", async () => {
    const runner = createTestRunner();
    const task = runner.app.task("inspect", async () => "ok");

    runner.dispatch(task, {});
    runner.dispatch(task, {});
    await new Promise((r) => setTimeout(r, 0));

    const inspector = runner.app.inspect();
    const stats = await inspector.stats({ task: "inspect" });
    expect(stats.waiting).toBe(2);

    await runner.processAll();
    const stats2 = await inspector.stats({ task: "inspect" });
    expect(stats2.completed).toBe(2);
    expect(stats2.waiting).toBe(0);
  });

  it("collect flush via advanceTime", async () => {
    const runner = createTestRunner();
    let receivedItems: unknown[] = [];

    const task = runner.app.task("batch", {
      collect: { key: "k", delay: "30s" },
      handler: async (items: { v: number }[]) => {
        receivedItems = items;
        return { count: items.length };
      },
    });

    runner.dispatch(task, { v: 1 });
    runner.dispatch(task, { v: 2 });
    runner.dispatch(task, { v: 3 });
    await new Promise((r) => setTimeout(r, 0));

    await runner.advanceTime("30s");
    expect(receivedItems).toHaveLength(3);
    expect(receivedItems).toEqual([{ v: 1 }, { v: 2 }, { v: 3 }]);
  });

  it("collect flush via runner.flush()", async () => {
    const runner = createTestRunner();
    let receivedItems: unknown[] = [];

    const task = runner.app.task("batch2", {
      collect: { key: "k", delay: "30s" },
      handler: async (items: { v: number }[]) => {
        receivedItems = items;
        return null;
      },
    });

    runner.dispatch(task, { v: 10 });
    runner.dispatch(task, { v: 20 });
    await new Promise((r) => setTimeout(r, 0));

    await runner.flush(task as unknown as import("../../src/task.js").Task<unknown, unknown>);
    expect(receivedItems).toHaveLength(2);
  });

  it("steps returns empty array (placeholder)", () => {
    const runner = createTestRunner();
    expect(runner.steps).toEqual([]);
  });

  // ── importTask ─────────────────────────────────────────────────────

  it("importTask() copies production task to memory adapter", async () => {
    // Simulate a "production" app with its own adapter
    const prodApp = taskora({ adapter: memoryAdapter() });
    const prodTask = prodApp.task("greet", {
      retry: { attempts: 2, backoff: "fixed", delay: 100, jitter: false },
      handler: async (data: { name: string }) => ({
        msg: `Hello, ${data.name}!`,
      }),
    });

    const runner = createTestRunner();
    const testTask = runner.importTask(prodTask);

    // run() works — handler is the same function
    const result = await runner.run(testTask, { name: "World" });
    expect(result).toEqual({ msg: "Hello, World!" });
  });

  it("importTask() enables dispatch + advanceTime on imported task", async () => {
    const prodApp = taskora({ adapter: memoryAdapter() });
    const prodTask = prodApp.task("compute", async (data: { x: number }) => ({
      doubled: data.x * 2,
    }));

    const runner = createTestRunner();
    const testTask = runner.importTask(prodTask);

    const handle = runner.dispatch(testTask, { x: 7 });
    await handle;
    expect(await handle.getState()).toBe("waiting");

    await runner.processAll();
    expect(await handle.getState()).toBe("completed");
  });

  it("importTask() preserves retry config", async () => {
    const prodApp = taskora({ adapter: memoryAdapter() });
    let attempts = 0;
    const prodTask = prodApp.task("flaky-prod", {
      retry: { attempts: 3, backoff: "fixed", delay: 100, jitter: false },
      handler: async () => {
        attempts++;
        if (attempts < 3) throw new Error("not yet");
        return { ok: true };
      },
    });

    const runner = createTestRunner();
    const testTask = runner.importTask(prodTask);

    const result = await runner.run(testTask, {});
    expect(result).toEqual({ ok: true });
    expect(attempts).toBe(3);
  });

  it("importTask() throws if task name already registered", () => {
    const prodApp = taskora({ adapter: memoryAdapter() });
    const prodTask = prodApp.task("dup", async () => null);

    const runner = createTestRunner();
    runner.importTask(prodTask);
    expect(() => runner.importTask(prodTask)).toThrow('Task "dup" is already registered');
  });

  // ── execute() ──────────────────────────────────────────────────────

  it("execute() runs full pipeline and returns result + metadata", async () => {
    const runner = createTestRunner();
    const task = runner.app.task("exec-test", {
      handler: async (data: { x: number }, ctx) => {
        ctx.progress(50);
        ctx.log.info("processing", { x: data.x });
        ctx.progress(100);
        return { doubled: data.x * 2 };
      },
    });

    const exec = await runner.execute(task, { x: 5 });
    expect(exec.state).toBe("completed");
    expect(exec.result).toEqual({ doubled: 10 });
    expect(exec.attempts).toBe(1);
    expect(exec.progress).toBe(100);
    expect(exec.logs).toHaveLength(1);
    expect(exec.logs[0].message).toBe("processing");
  });

  it("execute() auto-advances retries", async () => {
    const runner = createTestRunner();
    let attempts = 0;
    const task = runner.app.task("exec-retry", {
      retry: { attempts: 3, backoff: "fixed", delay: 5000, jitter: false },
      handler: async () => {
        attempts++;
        if (attempts < 3) throw new Error("not yet");
        return { ok: true };
      },
    });

    const exec = await runner.execute(task, {});
    expect(exec.state).toBe("completed");
    expect(exec.result).toEqual({ ok: true });
    expect(exec.attempts).toBe(3);
    expect(attempts).toBe(3);
  });

  it("execute() captures failure", async () => {
    const runner = createTestRunner();
    const task = runner.app.task("exec-fail", {
      handler: async () => {
        throw new Error("boom");
      },
    });

    const exec = await runner.execute(task, {});
    expect(exec.state).toBe("failed");
    expect(exec.result).toBeUndefined();
    expect(exec.error).toBe("boom");
  });

  it("execute() auto-imports unregistered task", async () => {
    const prodApp = taskora({ adapter: memoryAdapter() });
    const prodTask = prodApp.task("auto-import", async (data: { v: number }) => ({
      result: data.v * 3,
    }));

    const runner = createTestRunner();
    const exec = await runner.execute(prodTask, { v: 7 });
    expect(exec.state).toBe("completed");
    expect(exec.result).toEqual({ result: 21 });
  });

  // ── from: app (full app testing) ───────────────────────────────────

  it("from: app — interconnected tasks all run in memory", async () => {
    const prodApp = taskora({ adapter: memoryAdapter() });
    const results: string[] = [];

    const step1 = prodApp.task("step1", async (data: { msg: string }) => {
      results.push(`step1:${data.msg}`);
      await step2.dispatch({ msg: `from-step1:${data.msg}` });
      return null;
    });

    const step2 = prodApp.task("step2", async (data: { msg: string }) => {
      results.push(`step2:${data.msg}`);
      return null;
    });

    const runner = createTestRunner({ from: prodApp });

    const exec = await runner.execute(step1, { msg: "go" });
    expect(exec.state).toBe("completed");
    expect(results).toEqual(["step1:go", "step2:from-step1:go"]);

    // All jobs visible
    expect(runner.jobs).toHaveLength(2);
    expect(runner.jobs.every((j) => j.state === "completed")).toBe(true);

    runner.dispose();
  });

  it("from: app — dispose restores original adapter", async () => {
    const originalAdapter = memoryAdapter();
    const prodApp = taskora({ adapter: originalAdapter });
    const task = prodApp.task("restore-test", async () => "ok");

    const runner = createTestRunner({ from: prodApp });
    // Task dispatches to memory backend now
    const exec = await runner.execute(task, {});
    expect(exec.state).toBe("completed");

    runner.dispose();

    // After dispose, dispatch goes to the original adapter
    const handle = task.dispatch({});
    await handle;
    // Should be on the original adapter (not the test memory backend)
    expect(runner.jobs).toHaveLength(0); // test memory was cleared
  });

  it("from: app — three-level task chain", async () => {
    const prodApp = taskora({ adapter: memoryAdapter() });
    const log: string[] = [];

    const taskA = prodApp.task("a", async () => {
      log.push("a");
      await taskB.dispatch({});
      return null;
    });
    const taskB = prodApp.task("b", async () => {
      log.push("b");
      await taskC.dispatch({});
      return null;
    });
    const taskC = prodApp.task("c", async () => {
      log.push("c");
      return null;
    });

    const runner = createTestRunner({ from: prodApp });
    await runner.execute(taskA, {});
    expect(log).toEqual(["a", "b", "c"]);
    expect(runner.jobs).toHaveLength(3);

    runner.dispose();
  });
});
