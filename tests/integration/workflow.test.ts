import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTaskora } from "../../src/index.js";
import { chain, chord, group } from "../../src/workflow/index.js";
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

describe("workflow integration", () => {
  // ── Chain ──────────────────────────────────────────────────────────

  it("chain: two-step pipeline", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });

    const addTask = app.task("add", async (data: { x: number; y: number }) => data.x + data.y);
    const doubleTask = app.task("double", async (data: number) => data * 2);

    const handle = chain(addTask.s({ x: 3, y: 4 }), doubleTask.s()).dispatch();
    await handle;

    await app.start();

    const result = await handle.result;
    expect(result).toBe(14); // (3+4) * 2

    await app.close();
  });

  it("chain: three-step pipeline", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });

    const addTask = app.task("add", async (data: { x: number; y: number }) => data.x + data.y);
    const doubleTask = app.task("double", async (data: number) => data * 2);
    const toStringTask = app.task("to-string", async (data: number) => `result: ${data}`);

    const handle = chain(
      addTask.s({ x: 5, y: 5 }),
      doubleTask.s(),
      toStringTask.s(),
    ).dispatch();
    await handle;

    await app.start();

    const result = await handle.result;
    expect(result).toBe("result: 20");

    await app.close();
  });

  it("chain: .pipe() syntax", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });

    const addTask = app.task("add", async (data: { x: number; y: number }) => data.x + data.y);
    const doubleTask = app.task("double", async (data: number) => data * 2);

    const handle = addTask
      .s({ x: 1, y: 2 })
      .pipe(doubleTask.s())
      .pipe(doubleTask.s())
      .dispatch();
    await handle;

    await app.start();

    const result = await handle.result;
    expect(result).toBe(12); // (1+2) * 2 * 2

    await app.close();
  });

  // ── Group ──────────────────────────────────────────────────────────

  it("group: parallel execution", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });

    const addTask = app.task("add", async (data: { x: number; y: number }) => data.x + data.y);

    const handle = group(
      addTask.s({ x: 1, y: 2 }),
      addTask.s({ x: 3, y: 4 }),
      addTask.s({ x: 5, y: 6 }),
    ).dispatch();
    await handle;

    await app.start();

    const result = await handle.result;
    expect(result).toEqual([3, 7, 11]);

    await app.close();
  });

  // ── Chord ──────────────────────────────────────────────────────────

  it("chord: group + callback", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });

    const addTask = app.task("add", async (data: { x: number; y: number }) => data.x + data.y);
    const sumTask = app.task("sum", async (data: number[]) => data.reduce((a, b) => a + b, 0));

    const handle = chord(
      [addTask.s({ x: 1, y: 2 }), addTask.s({ x: 3, y: 4 })],
      sumTask.s(),
    ).dispatch();
    await handle;

    await app.start();

    const result = await handle.result;
    expect(result).toBe(10); // sum([3, 7])

    await app.close();
  });

  // ── Nested ─────────────────────────────────────────────────────────

  it("nested: chord of chains", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });

    const addTask = app.task("add", async (data: { x: number; y: number }) => data.x + data.y);
    const doubleTask = app.task("double", async (data: number) => data * 2);
    const sumTask = app.task("sum", async (data: number[]) => data.reduce((a, b) => a + b, 0));

    const handle = chord(
      [
        chain(addTask.s({ x: 1, y: 1 }), doubleTask.s()),
        chain(addTask.s({ x: 2, y: 2 }), doubleTask.s()),
      ],
      sumTask.s(),
    ).dispatch();
    await handle;

    await app.start();

    const result = await handle.result;
    expect(result).toBe(12); // sum([4, 8])

    await app.close();
  });

  // ── Workflow state ─────────────────────────────────────────────────

  it("workflow state: running → completed", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });

    const addTask = app.task("add", async (data: { x: number; y: number }) => data.x + data.y);

    const handle = addTask.s({ x: 1, y: 2 }).dispatch();
    await handle;

    const stateBefore = await handle.getState();
    expect(stateBefore).toBe("running");

    await app.start();

    await waitFor(async () => (await handle.getState()) === "completed");

    const stateAfter = await handle.getState();
    expect(stateAfter).toBe("completed");

    await app.close();
  });

  // ── Failure ────────────────────────────────────────────────────────

  it("workflow fails when a step fails permanently", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });

    const addTask = app.task("add", async (data: { x: number; y: number }) => data.x + data.y);
    app.task("boom", async () => {
      throw new Error("explosion");
    });
    const boomTask = app.task("boom-chain", async () => {
      throw new Error("explosion");
    });

    const handle = chain(addTask.s({ x: 1, y: 2 }), boomTask.s()).dispatch();
    await handle;

    await app.start();

    await waitFor(async () => {
      const s = await handle.getState();
      return s === "failed";
    });

    expect(await handle.getState()).toBe("failed");

    await app.close();
  });

  // ── Cancel ─────────────────────────────────────────────────────────

  it("cancel workflow cancels pending steps", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });

    let step2Ran = false;
    const slowTask = app.task("slow", async (_data: { n: number }, ctx) => {
      await new Promise((r) => setTimeout(r, 5000));
      return { n: _data.n };
    });
    const step2Task = app.task("step2", async () => {
      step2Ran = true;
      return "done";
    });

    const handle = chain(slowTask.s({ n: 1 }), step2Task.s()).dispatch();
    await handle;

    await app.start();

    // Wait briefly, then cancel
    await new Promise((r) => setTimeout(r, 200));
    await handle.cancel({ reason: "test cancel" });

    await waitFor(async () => {
      const s = await handle.getState();
      return s === "cancelled" || s === "failed";
    });

    expect(step2Ran).toBe(false);

    await app.close();
  });

  // ── .map() ─────────────────────────────────────────────────────────

  it("task.map(): parallel batch", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });

    const squareTask = app.task("square", async (data: { n: number }) => data.n * data.n);

    const handle = squareTask.map([{ n: 2 }, { n: 3 }, { n: 4 }]);
    await handle;

    await app.start();

    const result = await handle.result;
    expect(result).toEqual([4, 9, 16]);

    await app.close();
  });

  // ── Redis atomicity ────────────────────────────────────────────────

  it("workflow state is stored in Redis hash", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });

    const addTask = app.task("add", async (data: { x: number; y: number }) => data.x + data.y);

    const handle = chain(addTask.s({ x: 1, y: 2 }), addTask.s({ x: 10, y: 20 })).dispatch();
    await handle;

    // Check Redis directly
    const key = `taskora:wf:{${handle.workflowId}}`;
    const state = await redis.hget(key, "state");
    expect(state).toBe("running");

    const graphStr = await redis.hget(key, "graph");
    expect(graphStr).toBeTruthy();
    const graph = JSON.parse(graphStr as string);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.terminal).toEqual([1]);

    // Root nodes start as "pending" in workflow hash — they're enqueued as jobs
    // but the workflow hash only transitions to "active"/"completed" via advanceWorkflow
    const n0State = await redis.hget(key, "n:0:state");
    expect(n0State).toBe("pending");

    const n1State = await redis.hget(key, "n:1:state");
    expect(n1State).toBe("pending");

    await app.start();

    await waitFor(async () => (await handle.getState()) === "completed");

    const finalState = await redis.hget(key, "state");
    expect(finalState).toBe("completed");

    const result = await redis.hget(key, "result");
    expect(result).toBeTruthy();
    expect(JSON.parse(result as string)).toBe(30);

    await app.close();
  });

  it("_wf and _wfNode are stored in job hash", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });

    const echoTask = app.task("echo", async (data: string) => data);

    const handle = echoTask.s("hello").dispatch();
    await handle;

    // Find the job key via workflow graph
    const key = `taskora:wf:{${handle.workflowId}}`;
    const graphStr = await redis.hget(key, "graph");
    const graph = JSON.parse(graphStr as string);
    const jobId = graph.nodes[0].jobId;

    const jobKey = `taskora:{echo}:${jobId}`;
    const wf = await redis.hget(jobKey, "_wf");
    const wfNode = await redis.hget(jobKey, "_wfNode");

    expect(wf).toBe(handle.workflowId);
    expect(wfNode).toBe("0");

    await app.close();
  });
});
