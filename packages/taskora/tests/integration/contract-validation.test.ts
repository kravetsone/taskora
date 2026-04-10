import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as z from "zod";
import type { App } from "../../src/app.js";
import { ValidationError, createTaskora, defineTask } from "../../src/index.js";
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

describe("validateOnDispatch — producer-side schema validation", () => {
  const sendEmailContract = defineTask({
    name: "valid-send-email",
    input: z.object({ to: z.string().email(), subject: z.string() }),
    output: z.object({ messageId: z.string() }),
  });

  it("validates by default and throws ValidationError on invalid data", async () => {
    const app = createApp();
    const sendEmail = app.implement(sendEmailContract, async () => ({ messageId: "x" }));

    const handle = sendEmail.dispatch({
      // Cast to bypass TS — test simulates runtime invalid data
      to: "not-an-email",
      subject: "hi",
    } as never);

    await expect(handle).rejects.toBeInstanceOf(ValidationError);
  });

  it("accepts valid data by default (smoke test)", async () => {
    const app = createApp();
    const sendEmail = app.implement(sendEmailContract, async (data) => ({
      messageId: `id-${data.to}`,
    }));

    await app.start();
    const result = await sendEmail.dispatch({ to: "alice@example.com", subject: "hi" }).result;
    expect(result).toEqual({ messageId: "id-alice@example.com" });
  });

  it("validateOnDispatch: false globally — invalid data reaches the queue", async () => {
    const app = createApp({
      adapter: redisAdapter(url()),
      validateOnDispatch: false,
    });
    const sendEmail = app.register(sendEmailContract);

    // Invalid data — would throw if validation were on
    const handle = sendEmail.dispatch({ to: "not-an-email", subject: "hi" } as never);
    await handle; // resolves — enqueue succeeded
    expect(handle.id).toBeTruthy();

    // Worker-side validation is unaffected — if a worker picks this up
    // with its own schema, it would fail there. This test only asserts
    // the producer-side bypass.
    const found = await app.inspect().find(handle.id);
    expect(found?.state).toBe("waiting");
  });

  it("skipValidation: true per-call — overrides default-on", async () => {
    const app = createApp(); // validateOnDispatch default (true)
    const sendEmail = app.register(sendEmailContract);

    const handle = sendEmail.dispatch({ to: "not-an-email", subject: "hi" } as never, {
      skipValidation: true,
    });
    await handle;
    expect(handle.id).toBeTruthy();
  });

  it("skipValidation: false (or absent) keeps global validation on", async () => {
    const app = createApp();
    const sendEmail = app.register(sendEmailContract);

    // Explicit false — same as default
    const handle = sendEmail.dispatch({ to: "not-an-email", subject: "hi" } as never, {
      skipValidation: false,
    });
    await expect(handle).rejects.toBeInstanceOf(ValidationError);
  });

  it("no schema on contract → skipValidation is a no-op (does not throw)", async () => {
    const schemaless = defineTask<{ payload: string }, { ok: boolean }>({
      name: "valid-schemaless",
    });
    const app = createApp();
    const task = app.implement(schemaless, async () => ({ ok: true }));

    await app.start();
    const result = await task.dispatch({ payload: "anything" }).result;
    expect(result).toEqual({ ok: true });
  });
});
