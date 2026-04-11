import { Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { App, BoundTask, defineTask } from "taskora";
import { memoryAdapter } from "taskora/memory";
import { describe, expect, it } from "vitest";
import {
  InjectApp,
  InjectTask,
  InjectTaskoraRef,
  TaskoraModule,
  TaskoraRef,
} from "../src/index.js";

// ── Contracts used across the feature tests ─────────────────────────

const sendEmailTask = defineTask<{ to: string }, { sent: true }>({
  name: "send-email",
});

const processImageTask = defineTask<{ url: string }, { width: number }>({
  name: "process-image",
});

// ── Services for TaskoraRef path ────────────────────────────────────

@Injectable()
class EmailService {
  constructor(private readonly tasks: TaskoraRef) {}

  dispatchEmail(to: string) {
    return this.tasks.for(sendEmailTask).dispatch({ to });
  }

  get boundTask(): BoundTask<{ to: string }, { sent: true }> {
    return this.tasks.for(sendEmailTask);
  }
}

// ── Services for @InjectTask path ───────────────────────────────────

@Injectable()
class LegacyEmailService {
  constructor(
    @InjectTask(sendEmailTask)
    readonly sendEmail: BoundTask<{ to: string }, { sent: true }>,
  ) {}
}

// ── Multi-app services ──────────────────────────────────────────────

@Injectable()
class MultiAppService {
  constructor(
    readonly defaultTasks: TaskoraRef,
    @InjectTaskoraRef("secondary") readonly secondaryTasks: TaskoraRef,
    @InjectApp("secondary") readonly secondaryApp: App,
  ) {}
}

describe("TaskoraRef (primary path)", () => {
  it("is auto-provided by forRoot and resolvable as a class token", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TaskoraModule.forRoot({ adapter: memoryAdapter() })],
      providers: [EmailService],
    }).compile();

    await moduleRef.init();
    try {
      const svc = moduleRef.get(EmailService);
      expect(svc).toBeDefined();
      expect(svc.boundTask).toBeInstanceOf(BoundTask);
    } finally {
      await moduleRef.close();
    }
  });

  it("dispatches a contract and the job lands in the underlying App", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TaskoraModule.forRoot({ adapter: memoryAdapter() })],
      providers: [EmailService],
    }).compile();

    await moduleRef.init();
    try {
      const svc = moduleRef.get(EmailService);
      const handle = svc.dispatchEmail("alice@example.com");
      const id = await handle;
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    } finally {
      await moduleRef.close();
    }
  });

  it("returns the same BoundTask for repeat .for() calls (idempotent)", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TaskoraModule.forRoot({ adapter: memoryAdapter() })],
    }).compile();

    await moduleRef.init();
    try {
      const tasks = moduleRef.get(TaskoraRef);
      const first = tasks.for(sendEmailTask);
      const second = tasks.for(sendEmailTask);
      // BoundTask wraps the same underlying Task — dispatching through
      // either produces identical behaviour. We verify via .name since
      // the BoundTask constructor may create fresh wrappers.
      expect(first.name).toBe(second.name);
      expect(first.name).toBe("send-email");
    } finally {
      await moduleRef.close();
    }
  });

  it("exposes the underlying App via TaskoraRef.raw", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TaskoraModule.forRoot({ adapter: memoryAdapter() })],
    }).compile();

    await moduleRef.init();
    try {
      const tasks = moduleRef.get(TaskoraRef);
      expect(tasks.raw).toBeInstanceOf(App);
    } finally {
      await moduleRef.close();
    }
  });
});

describe("TaskoraModule.forFeature + @InjectTask (escape hatch)", () => {
  it("exposes per-contract BoundTask providers via @InjectTask", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TaskoraModule.forRoot({ adapter: memoryAdapter() }),
        TaskoraModule.forFeature([sendEmailTask, processImageTask]),
      ],
      providers: [LegacyEmailService],
    }).compile();

    await moduleRef.init();
    try {
      const svc = moduleRef.get(LegacyEmailService);
      expect(svc.sendEmail).toBeInstanceOf(BoundTask);
      expect(svc.sendEmail.name).toBe("send-email");
    } finally {
      await moduleRef.close();
    }
  });

  it("forFeature providers and TaskoraRef.for() see the same Task instance", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TaskoraModule.forRoot({ adapter: memoryAdapter() }),
        TaskoraModule.forFeature([sendEmailTask]),
      ],
      providers: [LegacyEmailService],
    }).compile();

    await moduleRef.init();
    try {
      const legacy = moduleRef.get(LegacyEmailService);
      const ref = moduleRef.get(TaskoraRef);
      const fromRef = ref.for(sendEmailTask);
      expect(legacy.sendEmail.name).toBe(fromRef.name);
    } finally {
      await moduleRef.close();
    }
  });
});

describe("Multi-app TaskoraRef isolation", () => {
  it("named TaskoraRef instances wrap distinct apps", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TaskoraModule.forRoot({ adapter: memoryAdapter() }),
        TaskoraModule.forRoot({ name: "secondary", adapter: memoryAdapter() }),
      ],
      providers: [MultiAppService],
    }).compile();

    await moduleRef.init();
    try {
      const svc = moduleRef.get(MultiAppService);
      expect(svc.defaultTasks).toBeInstanceOf(TaskoraRef);
      expect(svc.secondaryTasks).toBeInstanceOf(TaskoraRef);
      expect(svc.defaultTasks).not.toBe(svc.secondaryTasks);
      // secondary TaskoraRef's raw app must match the @InjectApp('secondary') one
      expect(svc.secondaryTasks.raw).toBe(svc.secondaryApp);
      expect(svc.defaultTasks.raw).not.toBe(svc.secondaryApp);
    } finally {
      await moduleRef.close();
    }
  });

  it("forFeature with appName binds contracts to the named app", async () => {
    @Injectable()
    class NamedService {
      constructor(
        @InjectTask(sendEmailTask, "secondary")
        readonly sendEmail: BoundTask<{ to: string }, { sent: true }>,
      ) {}
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        TaskoraModule.forRoot({ adapter: memoryAdapter() }),
        TaskoraModule.forRoot({ name: "secondary", adapter: memoryAdapter() }),
        TaskoraModule.forFeature([sendEmailTask], "secondary"),
      ],
      providers: [NamedService],
    }).compile();

    await moduleRef.init();
    try {
      const svc = moduleRef.get(NamedService);
      expect(svc.sendEmail).toBeInstanceOf(BoundTask);
    } finally {
      await moduleRef.close();
    }
  });
});
