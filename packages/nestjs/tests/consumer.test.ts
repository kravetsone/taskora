import { Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { App, type Taskora, defineTask } from "taskora";
import { memoryAdapter } from "taskora/memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnTaskEvent, TaskConsumer, TaskoraModule } from "../src/index.js";

// ── Contracts ───────────────────────────────────────────────────────

const sendEmailTask = defineTask<{ to: string }, { sent: true; messageId: string }>({
  name: "send-email-consumer-test",
});

const processImageTask = defineTask<{ url: string }, { width: number }>({
  name: "process-image-consumer-test",
});

const multiAppTask = defineTask<{ id: number }, { ok: true }>({
  name: "multi-app-consumer-test",
});

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * The full dispatch→worker→handler loop against the memory adapter is
 * a blocking loop — exercising it from unit tests would mean either
 * spinning up real Redis or black-magicking the test runner. Instead,
 * these tests disable autoStart so no worker is attached, then assert
 * directly against the Task that the explorer registered via
 * `app.implement()`. The explorer's job is mechanical: verify it called
 * `implement` with the right contract, stored the DI-backed handler,
 * and wired every `@OnTaskEvent` onto `task.on()`.
 */
const noAutoStart = { autoStart: false as const };

function makeFakeCtx(): Taskora.Context {
  return {} as Taskora.Context;
}

describe("@TaskConsumer — discovery + registration", () => {
  let implementSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    implementSpy = vi.spyOn(App.prototype, "implement");
  });

  afterEach(() => {
    implementSpy.mockRestore();
  });

  it("runs process() with constructor-injected dependencies", async () => {
    const sent: string[] = [];

    @Injectable()
    class MailerService {
      send(to: string) {
        sent.push(to);
        return `msg-${to}`;
      }
    }

    @TaskConsumer(sendEmailTask)
    class SendEmailConsumer {
      constructor(private readonly mailer: MailerService) {}

      async process(data: { to: string }, _ctx: Taskora.Context) {
        const messageId = this.mailer.send(data.to);
        return { sent: true as const, messageId };
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [TaskoraModule.forRoot({ adapter: memoryAdapter(), ...noAutoStart })],
      providers: [MailerService, SendEmailConsumer],
    }).compile();

    await moduleRef.init();
    try {
      expect(implementSpy).toHaveBeenCalledTimes(1);
      expect(implementSpy.mock.calls[0][0]).toBe(sendEmailTask);

      // The second arg is the closure the explorer built over the DI instance.
      // Invoke it directly — this is exactly what the worker would do once it
      // pulled a job off the queue.
      const handler = implementSpy.mock.calls[0][1] as (
        data: { to: string },
        ctx: Taskora.Context,
      ) => Promise<{ sent: true; messageId: string }>;

      const result = await handler({ to: "alice@example.com" }, makeFakeCtx());

      expect(result).toEqual({ sent: true, messageId: "msg-alice@example.com" });
      expect(sent).toEqual(["alice@example.com"]);
    } finally {
      await moduleRef.close();
    }
  });

  it("throws at bootstrap when @TaskConsumer class has no process() method", async () => {
    @TaskConsumer(processImageTask)
    class BrokenConsumer {
      // Intentionally missing `process` — should blow up at onApplicationBootstrap.
    }

    const moduleRef = await Test.createTestingModule({
      imports: [TaskoraModule.forRoot({ adapter: memoryAdapter(), ...noAutoStart })],
      providers: [BrokenConsumer],
    }).compile();

    await expect(moduleRef.init()).rejects.toThrow(
      /must implement a `process\(data, ctx\)` method/,
    );
    await moduleRef.close().catch(() => {});
  });

  it("forwards @TaskConsumer options to app.implement (concurrency etc.)", async () => {
    @TaskConsumer(sendEmailTask, { concurrency: 7, timeout: 1234 })
    class ConfiguredConsumer {
      async process(_data: { to: string }) {
        return { sent: true as const, messageId: "x" };
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [TaskoraModule.forRoot({ adapter: memoryAdapter(), ...noAutoStart })],
      providers: [ConfiguredConsumer],
    }).compile();

    await moduleRef.init();
    try {
      // The third arg to app.implement carries the ImplementOptions struct
      // that the explorer passes through after stripping `app`.
      expect(implementSpy).toHaveBeenCalledTimes(1);
      const options = implementSpy.mock.calls[0][2] as { concurrency?: number; timeout?: number };
      expect(options.concurrency).toBe(7);
      expect(options.timeout).toBe(1234);
      expect((options as { app?: unknown }).app).toBeUndefined();
    } finally {
      await moduleRef.close();
    }
  });
});

describe("@OnTaskEvent — per-task event wiring", () => {
  it("wires @OnTaskEvent methods onto task.on() so events reach the instance", async () => {
    const completedSpy = vi.fn();
    const failedSpy = vi.fn();

    @TaskConsumer(sendEmailTask)
    class EmailConsumer {
      async process(_data: { to: string }) {
        return { sent: true as const, messageId: "abc" };
      }

      @OnTaskEvent("completed")
      onDone(evt: unknown) {
        completedSpy(evt);
      }

      @OnTaskEvent("failed")
      onFail(evt: unknown) {
        failedSpy(evt);
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [TaskoraModule.forRoot({ adapter: memoryAdapter(), ...noAutoStart })],
      providers: [EmailConsumer],
    }).compile();

    await moduleRef.init();
    try {
      const app = moduleRef.get<App>("TASKORA_APP:default");
      const task = app.getTaskByName("send-email-consumer-test");
      expect(task).toBeDefined();

      // Poke the task emitter directly. task.on() wires the consumer's
      // method, and taskora's TypedEmitter re-dispatches through the
      // stream-reader path for real events — but for the wiring test we
      // care only that task.on was called with a function that calls the
      // DI-managed instance. TypedEmitter exposes `.emit()` internally
      // via the Task instance; we cast to unknown to bypass the fact
      // that it's not part of the public surface.
      const emitter = (task as unknown as { emitter: { emit: (e: string, p: unknown) => void } })
        .emitter;
      emitter.emit("completed", { fake: "payload" });
      emitter.emit("failed", { fake: "payload" });

      expect(completedSpy).toHaveBeenCalledTimes(1);
      expect(completedSpy).toHaveBeenCalledWith({ fake: "payload" });
      expect(failedSpy).toHaveBeenCalledTimes(1);
    } finally {
      await moduleRef.close();
    }
  });
});

describe("@TaskConsumer — multi-app isolation", () => {
  it("routes consumers to the matching named app via options.app", async () => {
    @TaskConsumer(multiAppTask)
    class DefaultConsumer {
      async process(_data: { id: number }) {
        return { ok: true as const };
      }
    }

    @TaskConsumer(multiAppTask, { app: "secondary" })
    class SecondaryConsumer {
      async process(_data: { id: number }) {
        return { ok: true as const };
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        TaskoraModule.forRoot({ adapter: memoryAdapter(), ...noAutoStart }),
        TaskoraModule.forRoot({
          name: "secondary",
          adapter: memoryAdapter(),
          ...noAutoStart,
        }),
      ],
      providers: [DefaultConsumer, SecondaryConsumer],
    }).compile();

    await moduleRef.init();
    try {
      const defaultApp = moduleRef.get<App>("TASKORA_APP:default");
      const secondaryApp = moduleRef.get<App>("TASKORA_APP:secondary");

      const defaultTask = defaultApp.getTaskByName("multi-app-consumer-test");
      const secondaryTask = secondaryApp.getTaskByName("multi-app-consumer-test");

      expect(defaultTask).toBeDefined();
      expect(secondaryTask).toBeDefined();
      // Two distinct Task instances bound to different apps — the explorer
      // routed each consumer to its matching forRoot.
      expect(defaultTask).not.toBe(secondaryTask);
    } finally {
      await moduleRef.close();
    }
  });
});
