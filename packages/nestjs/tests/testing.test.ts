import { Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type App, type Taskora, defineTask } from "taskora";
import { afterEach, describe, expect, it } from "vitest";
import { OnTaskEvent, TaskConsumer } from "../src/index.js";
import {
  type TaskoraTestHarness,
  TaskoraTestingModule,
  createTaskoraTestHarness,
} from "../src/testing/index.js";

// ── Contracts ───────────────────────────────────────────────────────

const sendEmailTask = defineTask<{ to: string }, { sent: true; messageId: string }>({
  name: "harness-send-email",
});

const boomTask = defineTask<{ trigger: "boom" }, never>({
  name: "harness-boom",
});

// ── Services used across harness tests ─────────────────────────────

@Injectable()
class MailerService {
  sent: string[] = [];
  send(to: string) {
    this.sent.push(to);
    return `msg-${to}`;
  }
}

@TaskConsumer(sendEmailTask)
class SendEmailConsumer {
  completedEvents = 0;

  constructor(private readonly mailer: MailerService) {}

  async process(data: { to: string }): Promise<{ sent: true; messageId: string }> {
    const messageId = this.mailer.send(data.to);
    return { sent: true, messageId };
  }

  @OnTaskEvent("completed")
  onDone(_evt: unknown) {
    this.completedEvents += 1;
  }
}

@TaskConsumer(boomTask)
class BoomConsumer {
  async process(_data: unknown, _ctx: Taskora.Context): Promise<never> {
    throw new Error("boom");
  }
}

describe("TaskoraTestingModule", () => {
  it("provides sensible defaults (memory adapter, autoStart: false)", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TaskoraTestingModule.forRoot()],
    }).compile();

    await moduleRef.init();
    try {
      const app = moduleRef.get<App>("TASKORA_APP:default");
      expect(app).toBeDefined();
      // autoStart: false means no worker attached — the subscribers
      // aren't running, and close() returns promptly.
    } finally {
      await moduleRef.close();
    }
  });

  it("honours explicit overrides (adapter/autoStart)", async () => {
    const { memoryAdapter } = await import("taskora/memory");
    const custom = memoryAdapter();

    const moduleRef = await Test.createTestingModule({
      imports: [TaskoraTestingModule.forRoot({ adapter: custom, autoStart: false })],
    }).compile();

    await moduleRef.init();
    try {
      const app = moduleRef.get<App>("TASKORA_APP:default");
      expect(app).toBeDefined();
    } finally {
      await moduleRef.close();
    }
  });
});

describe("createTaskoraTestHarness", () => {
  let harness: TaskoraTestHarness;

  afterEach(async () => {
    if (harness) await harness.close();
  });

  it("drives a @TaskConsumer end-to-end with DI-managed dependencies", async () => {
    harness = await createTaskoraTestHarness({
      providers: [MailerService, SendEmailConsumer],
    });

    const result = await harness.execute(sendEmailTask, { to: "alice@example.com" });

    expect(result.state).toBe("completed");
    expect(result.result).toEqual({ sent: true, messageId: "msg-alice@example.com" });

    // DI instance is the SAME across the harness → MailerService kept the record
    const mailer = harness.moduleRef.get(MailerService);
    expect(mailer.sent).toEqual(["alice@example.com"]);
  });

  it("captures @OnTaskEvent('completed') on the consumer instance", async () => {
    harness = await createTaskoraTestHarness({
      providers: [MailerService, SendEmailConsumer],
    });

    await harness.execute(sendEmailTask, { to: "bob@example.com" });

    const consumer = harness.moduleRef.get(SendEmailConsumer);
    expect(consumer.completedEvents).toBeGreaterThanOrEqual(1);
  });

  it("surfaces handler errors as a failed ExecutionResult (not a throw)", async () => {
    harness = await createTaskoraTestHarness({
      providers: [BoomConsumer],
    });

    const result = await harness.execute(boomTask, { trigger: "boom" });

    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/boom/);
    expect(result.result).toBeUndefined();
  });

  it("dispatch() returns a ResultHandle that resolves once the worker runs", async () => {
    harness = await createTaskoraTestHarness({
      providers: [MailerService, SendEmailConsumer],
    });

    const handle = harness.dispatch(sendEmailTask, { to: "carol@example.com" });
    expect(typeof handle.id).toBe("string");
    const result = await handle.result;
    expect(result).toEqual({ sent: true, messageId: "msg-carol@example.com" });
  });

  it("throws a clear error when executing a contract that wasn't registered", async () => {
    harness = await createTaskoraTestHarness({
      providers: [],
    });

    const orphanTask = defineTask<{ foo: string }, void>({ name: "harness-orphan" });

    await expect(harness.execute(orphanTask, { foo: "bar" })).rejects.toThrow(
      /no task "harness-orphan" is registered/,
    );
  });
});
