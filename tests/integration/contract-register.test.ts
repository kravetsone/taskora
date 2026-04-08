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

describe("App.register() — contract-first producer path", () => {
  const sendEmailContract = defineTask({
    name: "contract-send-email",
    input: z.object({ to: z.string(), subject: z.string() }),
    output: z.object({ messageId: z.string() }),
    retry: { attempts: 2 },
  });

  it("register() returns a BoundTask that dispatches to Redis", async () => {
    // Producer: registers contract, dispatches, never implements
    const producer = createApp();
    const sendEmail = producer.register(sendEmailContract);

    expect(sendEmail).toBeInstanceOf(BoundTask);
    expect(sendEmail.name).toBe("contract-send-email");

    const handle = sendEmail.dispatch({ to: "a@b.c", subject: "hi" });
    expect(typeof handle.id).toBe("string");
    await handle; // ensure enqueue resolved

    // Verify the job lives in the waiting state via the public Inspector API
    const stats = await producer.inspect().stats({ task: "contract-send-email" });
    expect(stats.waiting).toBe(1);

    const found = await producer.inspect().find(handle.id);
    expect(found).not.toBeNull();
    expect(found?.state).toBe("waiting");
    expect(found?.data).toEqual({ to: "a@b.c", subject: "hi" });
  });

  it("register() is idempotent — same contract name returns same underlying task", () => {
    const app = createApp();
    const a = app.register(sendEmailContract);
    const b = app.register(sendEmailContract);
    expect(a._task).toBe(b._task);
  });

  it("register() wraps an existing task.task()-declared task (mixed mode)", () => {
    const app = createApp();
    // Inline declaration first
    const inline = app.task<{ to: string; subject: string }, { messageId: string }>(
      "contract-send-email",
      async () => ({ messageId: "direct" }),
    );
    // Then register the contract with same name
    const bound = app.register(sendEmailContract);
    // Both point to the same underlying Task
    expect(bound._task).toBe(inline);
    // The inline handler remains active
    expect(bound._task.hasHandler).toBe(true);
  });

  it("producer-only process: start() skips contract-only tasks without error", async () => {
    const producer = createApp();
    producer.register(sendEmailContract);

    // No handler in this process. start() should succeed, no worker loop.
    await producer.start();
    // No jobs will be processed here; verify close() is clean
    await producer.close();
  });

  it("end-to-end: producer dispatches, separate worker app implements and processes", async () => {
    // Producer app: register + dispatch + subscribe to completed event
    const producer = createApp();
    const producerSendEmail = producer.register(sendEmailContract);

    const completedEvents: Array<{ id: string; result: { messageId: string } }> = [];
    producerSendEmail.on("completed", (e) => {
      completedEvents.push({ id: e.id, result: e.result });
    });

    // Worker app: manually create a Task with the same name + handler
    // (Commit 3 will add app.implement(contract, handler); for now we use app.task().)
    const worker = createApp();
    worker.task<{ to: string; subject: string }, { messageId: string }>("contract-send-email", {
      input: z.object({ to: z.string(), subject: z.string() }),
      output: z.object({ messageId: z.string() }),
      handler: async (data) => {
        return { messageId: `sent-to-${data.to}` };
      },
    });

    await producer.start(); // producer-only: no worker loop, but subscribes to events
    await worker.start(); // worker: runs the loop

    const handle = producerSendEmail.dispatch({ to: "x@y.z", subject: "hi" });
    const result = await handle.result;

    expect(result).toEqual({ messageId: "sent-to-x@y.z" });

    await waitFor(() => completedEvents.length === 1);
    expect(completedEvents[0].id).toBe(handle.id);
    expect(completedEvents[0].result).toEqual({ messageId: "sent-to-x@y.z" });
  });
});
