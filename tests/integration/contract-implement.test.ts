import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as z from "zod";
import type { App } from "../../src/app.js";
import { BoundTask, createTaskora, defineTask } from "../../src/index.js";
import { redisAdapter } from "../create-adapter.js";
import { url, waitFor } from "../helpers.js";

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

describe("App.implement() — contract + handler binding", () => {
  const sendEmailContract = defineTask({
    name: "impl-send-email",
    input: z.object({ to: z.string(), subject: z.string() }),
    output: z.object({ messageId: z.string() }),
    retry: { attempts: 2 },
  });

  it("bare handler form: implement(contract, handler) runs end-to-end", async () => {
    const app = createApp();
    const sendEmail = app.implement(sendEmailContract, async (data) => {
      return { messageId: `id-${data.to}` };
    });

    expect(sendEmail).toBeInstanceOf(BoundTask);
    expect(sendEmail.name).toBe("impl-send-email");
    expect(sendEmail._task.hasHandler).toBe(true);

    await app.start();
    const result = await sendEmail.dispatch({ to: "a@b.c", subject: "hi" }).result;
    expect(result).toEqual({ messageId: "id-a@b.c" });
  });

  it("handler + options form: implement(contract, handler, options) applies concurrency", async () => {
    const app = createApp();

    let maxConcurrent = 0;
    let current = 0;

    const slow = defineTask({
      name: "impl-slow",
      input: z.object({ id: z.number() }),
    });

    const slowTask = app.implement(
      slow,
      async () => {
        current++;
        if (current > maxConcurrent) maxConcurrent = current;
        await new Promise((r) => setTimeout(r, 50));
        current--;
        return null;
      },
      { concurrency: 3 },
    );

    await app.start();
    await Promise.all(Array.from({ length: 10 }, (_, i) => slowTask.dispatch({ id: i }).result));
    expect(maxConcurrent).toBe(3);
  });

  it("object form: implement(contract, { handler, ...options }) works", async () => {
    const app = createApp();

    const processed: string[] = [];
    const processImage = app.implement(sendEmailContract, {
      handler: async (data) => {
        processed.push(data.to);
        return { messageId: `obj-${data.to}` };
      },
      concurrency: 2,
      middleware: [
        async (_ctx, next) => {
          await next();
        },
      ],
    });

    await app.start();
    const result = await processImage.dispatch({ to: "x@y.z", subject: "hi" }).result;
    expect(result).toEqual({ messageId: "obj-x@y.z" });
    expect(processed).toEqual(["x@y.z"]);
  });

  it("implement() after register() upgrades the existing BoundTask in place", async () => {
    const app = createApp();

    // register first, hold the reference
    const boundEarly = app.register(sendEmailContract);
    expect(boundEarly._task.hasHandler).toBe(false);

    // implement later — should upgrade the SAME underlying Task
    const boundLate = app.implement(sendEmailContract, async (data) => ({
      messageId: `late-${data.to}`,
    }));

    expect(boundEarly._task).toBe(boundLate._task);
    expect(boundEarly._task.hasHandler).toBe(true);

    await app.start();
    // The EARLY reference still works — it points to the upgraded task
    const result = await boundEarly.dispatch({ to: "a@b.c", subject: "hi" }).result;
    expect(result).toEqual({ messageId: "late-a@b.c" });
  });

  it("double implement() throws", () => {
    const app = createApp();
    app.implement(sendEmailContract, async () => ({ messageId: "1" }));
    expect(() => app.implement(sendEmailContract, async () => ({ messageId: "2" }))).toThrow(
      /already implemented/,
    );
  });

  it("implement() with version override applies to dispatched jobs", async () => {
    const app = createApp();

    const versioned = defineTask({
      name: "impl-versioned",
      input: z.object({ value: z.string() }),
    });

    const task = app.implement(versioned, async (data) => data.value, {
      version: 5,
    });
    expect(task._task.version).toBe(5);

    await app.start();
    const handle = task.dispatch({ value: "ok" });
    await handle;

    const found = await app.inspect().find(handle.id);
    expect(found?.version).toBe(5);
  });
});
