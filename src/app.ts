import type { StandardSchemaV1 } from "@standard-schema/spec";
import { DeadLetterManager } from "./dlq.js";
import { TypedEmitter } from "./emitter.js";
import { Inspector } from "./inspector.js";
import type { Duration } from "./scheduler/duration.js";
import { parseDuration } from "./scheduler/duration.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { json } from "./serializer.js";
import { Task } from "./task.js";
import type { Taskora } from "./types.js";
import { Worker } from "./worker.js";

export interface TaskoraOptions {
  adapter: Taskora.Adapter;
  serializer?: Taskora.Serializer;
  scheduler?: Taskora.SchedulerConfig;
  deadLetterQueue?: Taskora.DeadLetterConfig;
  defaults?: {
    retry?: Taskora.RetryConfig;
    timeout?: number;
    concurrency?: number;
    stall?: Taskora.StallConfig;
  };
}

type MigrationFn = (data: unknown) => unknown;

interface TaskOptionsBase {
  concurrency?: number;
  timeout?: number;
  retry?: Taskora.RetryConfig;
  stall?: Taskora.StallConfig;
  singleton?: boolean;
  concurrencyLimit?: number;
  ttl?: Taskora.TtlConfig;
  middleware?: Taskora.Middleware[];
  version?: number;
  since?: number;
  migrate?: readonly MigrationFn[] | Record<number, MigrationFn>;
  schedule?: {
    every?: Duration;
    cron?: string;
    timezone?: string;
    onMissed?: Taskora.MissedPolicy;
    overlap?: boolean;
    data?: unknown;
  };
}

interface TaskOptionsWithSchema<TInput, TOutput> extends TaskOptionsBase {
  input: StandardSchemaV1<unknown, TInput>;
  output?: StandardSchemaV1<unknown, TOutput>;
  handler: (data: TInput, ctx: Taskora.Context) => Promise<TOutput> | TOutput;
}

interface TaskOptionsWithOutputSchema<TInput, TOutput> extends TaskOptionsBase {
  input?: undefined;
  output: StandardSchemaV1<unknown, TOutput>;
  handler: (data: TInput, ctx: Taskora.Context) => Promise<TOutput> | TOutput;
}

interface TaskOptionsNoSchema<TInput, TOutput> extends TaskOptionsBase {
  input?: undefined;
  output?: undefined;
  handler: (data: TInput, ctx: Taskora.Context) => Promise<TOutput> | TOutput;
}

interface CollectTaskOptions<TInput, TOutput> extends TaskOptionsBase {
  collect: {
    key: ((data: TInput) => string) | string;
    delay: Duration;
    maxSize?: number;
    maxWait?: Duration;
  };
  input?: StandardSchemaV1<unknown, TInput>;
  output?: StandardSchemaV1<unknown, TOutput>;
  handler: (items: TInput[], ctx: Taskora.Context) => Promise<TOutput> | TOutput;
}

export class App {
  readonly adapter: Taskora.Adapter;
  readonly serializer: Taskora.Serializer;
  readonly schedules: ScheduleManager;
  readonly deadLetters: DeadLetterManager;
  private readonly defaults: NonNullable<TaskoraOptions["defaults"]>;
  private readonly schedulerConfig?: Taskora.SchedulerConfig;
  /** @internal — used by Worker for DLQ trim */
  readonly dlqMaxAgeMs: number | null;

  private tasks = new Map<string, Task<unknown, unknown>>();
  private workers: Worker[] = [];
  private scheduler: Scheduler | null = null;
  private pendingSchedules: Array<{ name: string; config: Taskora.ScheduleConfig }> = [];
  private connected = false;
  private started = false;
  private middlewares: Taskora.Middleware[] = [];

  private readonly appEmitter = new TypedEmitter<Taskora.AppEventMap>();
  private tasksNeedingEvents = new Set<string>();
  private unsubscribe: (() => Promise<void>) | null = null;
  private hasAppTaskListeners = false;

  constructor(options: TaskoraOptions) {
    this.adapter = options.adapter;
    this.serializer = options.serializer ?? json();
    this.defaults = options.defaults ?? {};
    this.schedulerConfig = options.scheduler;
    this.schedules = new ScheduleManager(this);
    this.deadLetters = new DeadLetterManager(this.adapter, this.tasks, () => this.inspect());
    this.dlqMaxAgeMs = options.deadLetterQueue?.maxAge
      ? parseDuration(options.deadLetterQueue.maxAge)
      : null;
  }

  on<K extends keyof Taskora.AppEventMap & string>(
    event: K,
    handler: Taskora.AppEventMap[K] extends undefined
      ? () => void
      : (data: Taskora.AppEventMap[K]) => void,
  ): () => void {
    const unsub = this.appEmitter.on(event, handler as (data: Taskora.AppEventMap[K]) => void);

    if (event.startsWith("task:")) {
      this.hasAppTaskListeners = true;
      if (this.started) {
        this.ensureSubscription().catch((err) => {
          this.appEmitter.emit("worker:error", err instanceof Error ? err : new Error(String(err)));
        });
      }
    }

    return unsub;
  }

  use(middleware: Taskora.Middleware): this {
    if (this.started) {
      throw new Error("Cannot add middleware after app.start()");
    }
    this.middlewares.push(middleware);
    return this;
  }

  task<TInput, TOutput>(
    name: string,
    handler: (data: TInput, ctx: Taskora.Context) => Promise<TOutput> | TOutput,
  ): Task<TInput, TOutput>;
  task<TInput, TOutput>(
    name: string,
    options: CollectTaskOptions<TInput, TOutput>,
  ): Task<TInput, TOutput>;
  task<TInput, TOutput>(
    name: string,
    options: TaskOptionsWithSchema<TInput, TOutput>,
  ): Task<TInput, TOutput>;
  task<TInput, TOutput>(
    name: string,
    options: TaskOptionsWithOutputSchema<TInput, TOutput>,
  ): Task<TInput, TOutput>;
  task<TInput, TOutput>(
    name: string,
    options: TaskOptionsNoSchema<TInput, TOutput>,
  ): Task<TInput, TOutput>;
  task<TInput, TOutput>(
    name: string,
    handlerOrOptions:
      | ((data: TInput, ctx: Taskora.Context) => Promise<TOutput> | TOutput)
      | (TaskOptionsBase & {
          input?: StandardSchemaV1<unknown, TInput>;
          output?: StandardSchemaV1<unknown, TOutput>;
          handler: (data: TInput | TInput[], ctx: Taskora.Context) => Promise<TOutput> | TOutput;
          collect?: CollectTaskOptions<TInput, TOutput>["collect"];
        }),
  ): Task<TInput, TOutput> {
    if (this.tasks.has(name)) {
      throw new Error(`Task "${name}" is already registered`);
    }

    const isFunction = typeof handlerOrOptions === "function";
    const handler = isFunction ? handlerOrOptions : handlerOrOptions.handler;
    const concurrency =
      (!isFunction ? handlerOrOptions.concurrency : undefined) ?? this.defaults.concurrency ?? 1;
    const timeout =
      (!isFunction ? handlerOrOptions.timeout : undefined) ?? this.defaults.timeout ?? 30_000;
    const retry = (!isFunction ? handlerOrOptions.retry : undefined) ?? this.defaults.retry;
    const stall = (!isFunction ? handlerOrOptions.stall : undefined) ?? this.defaults.stall;
    const singleton = !isFunction ? handlerOrOptions.singleton : undefined;
    const concurrencyLimit = !isFunction ? handlerOrOptions.concurrencyLimit : undefined;
    const ttlOpt = !isFunction ? handlerOrOptions.ttl : undefined;
    const ttl = ttlOpt
      ? {
          maxMs: parseDuration(ttlOpt.max),
          onExpire: (ttlOpt.onExpire ?? "fail") as "fail" | "discard",
        }
      : undefined;
    const taskMiddleware = !isFunction ? handlerOrOptions.middleware : undefined;

    const collectOpt = !isFunction
      ? (handlerOrOptions as { collect?: CollectTaskOptions<TInput, TOutput>["collect"] }).collect
      : undefined;
    const collect = collectOpt
      ? {
          key: collectOpt.key as ((data: unknown) => string) | string,
          delayMs: parseDuration(collectOpt.delay),
          maxSize: collectOpt.maxSize ?? 0,
          maxWaitMs: collectOpt.maxWait ? parseDuration(collectOpt.maxWait) : 0,
        }
      : undefined;

    const migrationConfig =
      !isFunction &&
      (handlerOrOptions.version || handlerOrOptions.since || handlerOrOptions.migrate)
        ? {
            version: handlerOrOptions.version,
            since: handlerOrOptions.since,
            migrate: handlerOrOptions.migrate,
          }
        : undefined;

    const task = new Task<TInput, TOutput>(
      {
        adapter: this.adapter,
        serializer: this.serializer,
        ensureConnected: () => this.ensureConnected(),
        onEventSubscribe: (taskName) => {
          this.tasksNeedingEvents.add(taskName);
          if (this.started) {
            this.ensureSubscription().catch((err) => {
              this.appEmitter.emit(
                "worker:error",
                err instanceof Error ? err : new Error(String(err)),
              );
            });
          }
        },
      },
      name,
      handler,
      { concurrency, timeout, retry, stall, singleton, concurrencyLimit, ttl, collect },
      !isFunction ? { input: handlerOrOptions.input, output: handlerOrOptions.output } : undefined,
      migrationConfig,
      taskMiddleware,
    );

    this.tasks.set(name, task as Task<unknown, unknown>);

    // Inline schedule support
    const scheduleOpts = !isFunction ? handlerOrOptions.schedule : undefined;
    if (scheduleOpts) {
      const config: Taskora.ScheduleConfig = {
        task: name,
        every: scheduleOpts.every,
        cron: scheduleOpts.cron,
        timezone: scheduleOpts.timezone,
        onMissed: scheduleOpts.onMissed,
        overlap: scheduleOpts.overlap,
        data: scheduleOpts.data,
      };
      this.pendingSchedules.push({ name, config });
    }

    return task;
  }

  schedule(name: string, config: Taskora.ScheduleConfig): void {
    if (!config.every && !config.cron) {
      throw new Error("Schedule must have either 'every' or 'cron'");
    }
    this.pendingSchedules.push({ name, config });
  }

  inspect(): Inspector {
    return new Inspector(this.adapter, this.serializer, this.tasks);
  }

  /** @internal — used by ScheduleManager */
  getTaskByName(name: string): Task<unknown, unknown> | undefined {
    return this.tasks.get(name);
  }

  /** @internal — used by ScheduleManager */
  getScheduler(): Scheduler | null {
    return this.scheduler;
  }

  async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.adapter.connect();
      this.connected = true;
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.ensureConnected();
    this.started = true;

    // Subscribe to event streams BEFORE starting workers
    // so XREVRANGE snapshots positions before any jobs are processed
    await this.ensureSubscription();

    for (const task of this.tasks.values()) {
      const worker = new Worker(
        task,
        this.adapter,
        this.serializer,
        this.dlqMaxAgeMs,
        this.middlewares,
      );
      this.workers.push(worker);
      worker.start();
    }

    // Start scheduler if there are schedules or scheduler config is provided
    if (this.pendingSchedules.length > 0 || this.schedulerConfig) {
      this.scheduler = new Scheduler(
        {
          adapter: this.adapter,
          serializer: this.serializer,
          getTask: (name) => this.tasks.get(name),
        },
        this.schedulerConfig,
      );

      for (const { name, config } of this.pendingSchedules) {
        await this.scheduler.registerSchedule(name, config);
      }
      this.pendingSchedules = [];

      await this.scheduler.start();
    }

    this.appEmitter.emit("worker:ready");
  }

  async close(options?: { timeout?: number }): Promise<void> {
    this.appEmitter.emit("worker:closing");

    if (this.scheduler) {
      await this.scheduler.stop();
      this.scheduler = null;
    }

    if (this.unsubscribe) {
      const unsub = this.unsubscribe;
      this.unsubscribe = null;
      await unsub();
    }

    const stopPromises = this.workers.map((w) => w.stop(options?.timeout));
    await Promise.allSettled(stopPromises);
    this.workers = [];
    this.started = false;

    if (this.connected) {
      await this.adapter.disconnect();
      this.connected = false;
    }
  }

  private async ensureSubscription(): Promise<void> {
    const taskNames = this.getTasksToSubscribe();
    if (taskNames.length === 0) return;
    if (this.unsubscribe) return; // already running

    this.unsubscribe = await this.adapter.subscribe(taskNames, (raw) =>
      this.handleStreamEvent(raw),
    );
  }

  private getTasksToSubscribe(): string[] {
    if (this.hasAppTaskListeners) {
      return [...this.tasks.keys()];
    }
    return [...this.tasksNeedingEvents];
  }

  private handleStreamEvent(raw: Taskora.StreamEvent): void {
    const task = this.tasks.get(raw.task);
    if (!task) return;

    const { event, jobId, fields } = raw;

    switch (event) {
      case "completed": {
        const result = fields.result ? this.serializer.deserialize(fields.result) : undefined;
        const payload: Taskora.CompletedEvent<unknown> = {
          id: jobId,
          result,
          duration: Number(fields.duration || 0),
          attempt: Number(fields.attempt || 1),
        };
        task.dispatchEvent("completed", payload);
        this.appEmitter.emit("task:completed", { ...payload, task: raw.task });
        break;
      }
      case "failed": {
        const payload: Taskora.FailedEvent = {
          id: jobId,
          error: fields.error || "Unknown error",
          attempt: Number(fields.attempt || 1),
          willRetry: false,
        };
        task.dispatchEvent("failed", payload);
        this.appEmitter.emit("task:failed", { ...payload, task: raw.task });
        break;
      }
      case "retrying": {
        // Emit "failed" with willRetry=true AND "retrying" with details
        const failedPayload: Taskora.FailedEvent = {
          id: jobId,
          error: fields.error || "Unknown error",
          attempt: Number(fields.attempt || 1),
          willRetry: true,
        };
        task.dispatchEvent("failed", failedPayload);
        this.appEmitter.emit("task:failed", { ...failedPayload, task: raw.task });

        const retryPayload: Taskora.RetryingEvent = {
          id: jobId,
          attempt: Number(fields.attempt || 1),
          nextAttempt: Number(fields.nextAttemptAt || 0),
          error: fields.error || "Unknown error",
        };
        task.dispatchEvent("retrying", retryPayload);
        break;
      }
      case "active": {
        const payload: Taskora.ActiveEvent = {
          id: jobId,
          attempt: Number(fields.attempt || 1),
        };
        task.dispatchEvent("active", payload);
        this.appEmitter.emit("task:active", { ...payload, task: raw.task });
        break;
      }
      case "progress": {
        let progress: number | Record<string, unknown> = 0;
        const val = fields.value;
        if (val) {
          const num = Number(val);
          if (!Number.isNaN(num) && String(num) === val) {
            progress = num;
          } else {
            progress = JSON.parse(val);
          }
        }
        task.dispatchEvent("progress", { id: jobId, progress });
        break;
      }
      case "stalled": {
        const action = fields.action as "recovered" | "failed";
        const payload: Taskora.StalledEvent = {
          id: jobId,
          count: Number(fields.count || 1),
          action,
        };
        task.dispatchEvent("stalled", payload);
        this.appEmitter.emit("task:stalled", { ...payload, task: raw.task });
        break;
      }
    }
  }
}

// ── ScheduleManager ─────────────────────────────────────────────────

class ScheduleManager {
  constructor(private readonly app: App) {}

  async list(): Promise<Taskora.ScheduleInfo[]> {
    const records = await this.app.adapter.listSchedules();
    return records.map((r) => {
      const config: Taskora.ScheduleConfig = JSON.parse(r.config);
      const stored = JSON.parse(r.config);
      return {
        name: r.name,
        config,
        nextRun: r.nextRun,
        lastRun: stored.lastRun ?? null,
        lastJobId: stored.lastJobId ?? null,
        paused: r.nextRun === null,
      };
    });
  }

  async pause(name: string): Promise<void> {
    await this.app.adapter.pauseSchedule(name);
  }

  async resume(name: string): Promise<void> {
    const record = await this.app.adapter.getSchedule(name);
    if (!record) throw new Error(`Schedule "${name}" not found`);

    const scheduler = this.app.getScheduler();
    if (!scheduler) throw new Error("Scheduler is not running");

    const stored = JSON.parse(record.config);
    const nextRun = await scheduler.computeNextRun(stored, Date.now());
    await this.app.adapter.resumeSchedule(name, nextRun);
  }

  async update(
    name: string,
    updates: Partial<
      Pick<Taskora.ScheduleConfig, "every" | "cron" | "timezone" | "onMissed" | "overlap" | "data">
    >,
  ): Promise<void> {
    const record = await this.app.adapter.getSchedule(name);
    if (!record) throw new Error(`Schedule "${name}" not found`);

    const stored = JSON.parse(record.config);

    if (updates.every !== undefined) {
      stored.every = parseDuration(updates.every);
      stored.cron = undefined;
      stored.timezone = undefined;
    }
    if (updates.cron !== undefined) {
      stored.cron = updates.cron;
      stored.every = undefined;
    }
    if (updates.timezone !== undefined) stored.timezone = updates.timezone;
    if (updates.onMissed !== undefined) stored.onMissed = updates.onMissed;
    if (updates.overlap !== undefined) stored.overlap = updates.overlap;
    if (updates.data !== undefined) stored.data = updates.data;

    const scheduler = this.app.getScheduler();
    if (!scheduler) throw new Error("Scheduler is not running");

    const nextRun = await scheduler.computeNextRun(stored, Date.now());
    await this.app.adapter.updateScheduleNextRun(name, JSON.stringify(stored), nextRun);
  }

  async remove(name: string): Promise<void> {
    await this.app.adapter.removeSchedule(name);
  }

  async trigger(name: string): Promise<import("./result.js").ResultHandle<unknown>> {
    const record = await this.app.adapter.getSchedule(name);
    if (!record) throw new Error(`Schedule "${name}" not found`);

    const config: Taskora.ScheduleConfig = JSON.parse(record.config);
    const task = this.app.getTaskByName(config.task);
    if (!task) throw new Error(`Task "${config.task}" not found`);

    const data = config.data !== undefined ? config.data : null;
    return task.dispatch(data as never);
  }
}
