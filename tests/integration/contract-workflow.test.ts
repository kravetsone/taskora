import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as z from "zod";
import type { App } from "../../src/app.js";
import { createTaskora, defineTask } from "../../src/index.js";
import { chain, chord, group } from "../../src/workflow/index.js";
import { redisAdapter } from "../create-adapter.js";
import { url } from "../helpers.js";

let redis: Redis;
const apps: App[] = [];

function createApp(opts?: Parameters<typeof createTaskora>[0]) {
  const app = createTaskora({ adapter: redisAdapter(url()), ...opts });
  apps.push(app);
  return app;
}

beforeEach(() => {
  redis = new Redis(url());
});

afterEach(async () => {
  await Promise.allSettled(apps.map((a) => a.close()));
  apps.length = 0;
  await redis.flushdb();
  await redis.quit();
});

describe("Workflows composed from contract-defined tasks", () => {
  // Shared contracts — zero runtime deps beyond z + defineTask
  const addContract = defineTask({
    name: "wf-add",
    input: z.object({ x: z.number(), y: z.number() }),
    output: z.number(),
  });
  const doubleContract = defineTask({
    name: "wf-double",
    input: z.number(),
    output: z.number(),
  });
  const toStringContract = defineTask({
    name: "wf-to-string",
    input: z.number(),
    output: z.string(),
  });

  it("chain() from BoundTasks created via implement()", async () => {
    const app = createApp();

    const add = app.implement(addContract, async (data) => data.x + data.y);
    const double = app.implement(doubleContract, async (data) => data * 2);
    const toStr = app.implement(toStringContract, async (data) => `result: ${data}`);

    await app.start();
    const handle = chain(add.s({ x: 3, y: 4 }), double.s(), toStr.s()).dispatch();
    const result = await handle.result;
    expect(result).toBe("result: 14");
  });

  it("group() with tuple result from contract-based BoundTasks", async () => {
    const app = createApp();
    const add = app.implement(addContract, async (data) => data.x + data.y);

    await app.start();
    const handle = group(
      add.s({ x: 1, y: 2 }),
      add.s({ x: 10, y: 20 }),
      add.s({ x: 100, y: 200 }),
    ).dispatch();
    const result = await handle.result;
    expect(result).toEqual([3, 30, 300]);
  });

  it("chord() — group of contract tasks feeds a contract callback", async () => {
    const app = createApp();

    const sumContract = defineTask({
      name: "wf-sum",
      input: z.array(z.number()),
      output: z.number(),
    });

    const add = app.implement(addContract, async (data) => data.x + data.y);
    const sum = app.implement(sumContract, async (values) => values.reduce((acc, n) => acc + n, 0));

    await app.start();
    const handle = chord(
      [add.s({ x: 1, y: 1 }), add.s({ x: 2, y: 2 }), add.s({ x: 3, y: 3 })],
      sum.s(),
    ).dispatch();
    const result = await handle.result;
    expect(result).toBe(2 + 4 + 6);
  });

  it("producer/consumer split: producer composes with register(), worker implements", async () => {
    // Producer: registers contracts, composes workflow, dispatches.
    // No handler code lives in the producer process.
    const producer = createApp();
    const pAdd = producer.register(addContract);
    const pDouble = producer.register(doubleContract);

    // Worker: implements the same contracts. Separate app instance.
    const worker = createApp();
    worker.implement(addContract, async (data) => data.x + data.y);
    worker.implement(doubleContract, async (data) => data * 2);

    // Producer has no handlers — start() is still safe (worker loop skipped)
    await producer.start();
    await worker.start();

    const handle = chain(pAdd.s({ x: 7, y: 8 }), pDouble.s()).dispatch();
    const result = await handle.result;
    expect(result).toBe(30); // (7+8) * 2
  });

  it("BoundTask.map(): dispatch one contract-defined job per item", async () => {
    const app = createApp();
    const double = app.implement(doubleContract, async (data) => data * 2);

    await app.start();
    const handle = double.map([1, 2, 3, 4, 5]);
    const result = await handle.result;
    expect(result).toEqual([2, 4, 6, 8, 10]);
  });

  it("mixed: contract-based BoundTask composes with inline app.task()", async () => {
    // Not a primary pattern, but should not break: inline-declared tasks
    // and contract-based BoundTasks produce Signatures with the same shape.
    const app = createApp();

    const addInline = app.task("wf-add-inline", async (data: { x: number; y: number }) => {
      return data.x + data.y;
    });
    const double = app.implement(doubleContract, async (data) => data * 2);

    await app.start();
    const handle = chain(addInline.s({ x: 10, y: 5 }), double.s()).dispatch();
    const result = await handle.result;
    expect(result).toBe(30);
  });
});
