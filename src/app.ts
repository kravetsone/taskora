import type { StandardSchemaV1 } from "@standard-schema/spec";
import { BoundTask } from "./bound-task.js";
import type { TaskContract } from "./contract.js";
import { DeadLetterManager } from "./dlq.js";
import { TypedEmitter } from "./emitter.js";
import { SchemaVersionMismatchError } from "./errors.js";
import { Inspector } from "./inspector.js";
import type { Duration } from "./scheduler/duration.js";
import { parseDuration } from "./scheduler/duration.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { json } from "./serializer.js";
import { Task, type TaskConfig, type TaskDeps, type TaskMigrationConfig } from "./task.js";
import type { Taskora } from "./types.js";
import { checkCompat, currentMeta } from "./wire-version.js";
import { Worker } from "./worker.js";

export interface TaskoraOptions {
  adapter: Taskora.Adapter;
  serializer?: Taskora.Serializer;
  scheduler?: Taskora.SchedulerConfig;
  retention?: Taskora.RetentionOptions;
  defaults?: {
    retry?: Taskora.RetryConfig;
    timeout?: number;
    concurrency?: number;
    stall?: Taskora.StallConfig;
  };
  /**
   * Whether `dispatch()` validates input via the task's Standard Schema
   * before enqueueing. Disable when the producer fully trusts the input
   * (e.g. already validated upstream) and you want to skip the schema
   * cost. Worker-side validation is unaffected — it always runs before
   * the handler so job data is still checked at some boundary.
   *
   * Per-call `dispatch(data, { skipValidation: true })` overrides this.
   * Default: `true`.
   */
  validateOnDispatch?: boolean;
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
  onCancel?: (data: unknown, ctx: Taskora.Context) => Promise<void> | void;
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

/**
 * Worker-side configuration accepted by {@link App.implement}. Schemas live
 * on the {@link TaskContract}, not here — `implement()` only attaches the
 * handler and execution config (concurrency, middleware, migrations, etc).
 *
 * Fields that overlap with the contract (`retry`, `timeout`, `stall`,
 * `version`) act as worker-side overrides when set.
 */
export interface ImplementOptions {
  concurrency?: number;
  timeout?: number;
  retry?: Taskora.RetryConfig;
  stall?: Taskora.StallConfig;
  singleton?: boolean;
  concurrencyLimit?: number;
  ttl?: Taskora.TtlConfig;
  middleware?: Taskora.Middleware[];
  onCancel?: (data: unknown, ctx: Taskora.Context) => Promise<void> | void;
  version?: number;
  since?: number;
  migrate?: readonly MigrationFn[] | Record<number, MigrationFn>;
}

interface ImplementOptionsWithHandler<TInput, TOutput> extends ImplementOptions {
  handler: (data: TInput, ctx: Taskora.Context) => Promise<TOutput> | TOutput;
  collect?: never;
}

interface ImplementCollectOptions<TInput, TOutput> extends ImplementOptions {
  collect: {
    key: ((data: TInput) => string) | string;
    delay: Duration;
    maxSize?: number;
    maxWait?: Duration;
  };
  handler: (items: TInput[], ctx: Taskora.Context) => Promise<TOutput> | TOutput;
}

export class App {
  readonly adapter: Taskora.Adapter;
  readonly serializer: Taskora.Serializer;
  readonly schedules: ScheduleManager;
  readonly deadLetters: DeadLetterManager;
  private readonly defaults: NonNullable<TaskoraOptions["defaults"]>;
  private readonly schedulerConfig?: Taskora.SchedulerConfig;
  private readonly validateOnDispatch: boolean;
  /** @internal — used by Worker for retention trim */
  readonly retention: {
    completed: { maxAgeMs: number; maxItems: number };
    failed: { maxAgeMs: number; maxItems: number };
  };

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
    this.validateOnDispatch = options.validateOnDispatch ?? true;
    this.schedules = new ScheduleManager(this);
    this.deadLetters = new DeadLetterManager(this.adapter, this.tasks, () => this.inspect());
    this.retention = {
      completed: {
        maxAgeMs: parseDuration(options.retention?.completed?.maxAge ?? "1h"),
        maxItems: options.retention?.completed?.maxItems ?? 100,
      },
      failed: {
        maxAgeMs: parseDuration(options.retention?.failed?.maxAge ?? "7d"),
        maxItems: options.retention?.failed?.maxItems ?? 300,
      },
    };
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
    const onCancel = !isFunction ? handlerOrOptions.onCancel : undefined;

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
      this.buildTaskDeps(),
      name,
      handler,
      { concurrency, timeout, retry, stall, singleton, concurrencyLimit, ttl, collect, onCancel },
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

  /**
   * Register a task contract without a handler. Returns a {@link BoundTask}
   * that can dispatch jobs — intended for producer-only processes where the
   * handler lives in a separate worker process.
   *
   * Idempotent: calling `register()` twice for the same task name returns the
   * same underlying task. If a task with that name already exists (via
   * `app.task()` or a prior `app.implement()`), the existing task is wrapped
   * and its handler is left untouched.
   *
   * @example
   * ```ts
   * // producer.ts
   * import { sendEmailContract } from "./contracts.js"
   * const sendEmail = taskora.register(sendEmailContract)
   * await sendEmail.dispatch({ to: "a@b.c", subject: "Welcome" })
   * ```
   */
  register<TInput, TOutput>(contract: TaskContract<TInput, TOutput>): BoundTask<TInput, TOutput> {
    const existing = this.tasks.get(contract.name) as Task<TInput, TOutput> | undefined;
    if (existing) {
      return new BoundTask(existing);
    }

    const safetyHandler: (data: TInput, ctx: Taskora.Context) => Promise<TOutput> = async () => {
      throw new Error(
        `Task "${contract.name}" was registered as a contract but no handler has been implemented in this process. Call taskora.implement(contract, handler) in the process that should execute it.`,
      );
    };

    const retry = contract.retry ?? this.defaults.retry;
    const timeout = contract.timeout
      ? parseDuration(contract.timeout)
      : (this.defaults.timeout ?? 30_000);
    const stall = contract.stall ?? this.defaults.stall;
    const concurrency = this.defaults.concurrency ?? 1;

    const task = new Task<TInput, TOutput>(
      this.buildTaskDeps(),
      contract.name,
      safetyHandler,
      { concurrency, timeout, retry, stall },
      contract.input || contract.output
        ? { input: contract.input, output: contract.output }
        : undefined,
      contract.version !== undefined ? { version: contract.version } : undefined,
    );

    task.hasHandler = false;
    this.tasks.set(contract.name, task as Task<unknown, unknown>);
    return new BoundTask(task);
  }

  /**
   * Attach a handler to a task contract. Returns a {@link BoundTask} ready
   * to dispatch and to run inside this process's worker loop.
   *
   * Three call forms, pick whichever fits:
   * ```ts
   * // 1. Bare handler (most common)
   * taskora.implement(sendEmail, async (data, ctx) => {
   *   return { messageId: await mailer.send(data) }
   * })
   *
   * // 2. Handler + worker-side options
   * taskora.implement(
   *   processImage,
   *   async (data, ctx) => { ... },
   *   { concurrency: 4, middleware: [withTracing()] },
   * )
   *
   * // 3. Object form — required for collect tasks and preferred when
   * //    onCancel is heavy or you want all config in one place
   * taskora.implement(batchEmail, {
   *   collect: { key: "user-emails", delay: "5s" },
   *   handler: async (items, ctx) => { ... },
   * })
   * ```
   *
   * Throws if the same contract is implemented twice in the same process.
   * If {@link register} was called first, the contract's existing
   * `BoundTask` is reused and its handler is upgraded in place — existing
   * `BoundTask` references continue to work.
   */
  implement<TInput, TOutput>(
    contract: TaskContract<TInput, TOutput>,
    handler: (data: TInput, ctx: Taskora.Context) => Promise<TOutput> | TOutput,
  ): BoundTask<TInput, TOutput>;
  implement<TInput, TOutput>(
    contract: TaskContract<TInput, TOutput>,
    handler: (data: TInput, ctx: Taskora.Context) => Promise<TOutput> | TOutput,
    options: ImplementOptions,
  ): BoundTask<TInput, TOutput>;
  implement<TInput, TOutput>(
    contract: TaskContract<TInput, TOutput>,
    options:
      | ImplementOptionsWithHandler<TInput, TOutput>
      | ImplementCollectOptions<TInput, TOutput>,
  ): BoundTask<TInput, TOutput>;
  implement<TInput, TOutput>(
    contract: TaskContract<TInput, TOutput>,
    handlerOrOptions:
      | ((data: TInput, ctx: Taskora.Context) => Promise<TOutput> | TOutput)
      | ImplementOptionsWithHandler<TInput, TOutput>
      | ImplementCollectOptions<TInput, TOutput>,
    maybeOptions?: ImplementOptions,
  ): BoundTask<TInput, TOutput> {
    const isFunction = typeof handlerOrOptions === "function";
    const handler = (isFunction ? handlerOrOptions : handlerOrOptions.handler) as Task<
      TInput,
      TOutput
    >["handler"];
    const options: ImplementOptions & {
      collect?: ImplementCollectOptions<TInput, TOutput>["collect"];
    } = isFunction ? (maybeOptions ?? {}) : handlerOrOptions;

    const existing = this.tasks.get(contract.name) as Task<TInput, TOutput> | undefined;
    if (existing?.hasHandler) {
      throw new Error(
        `Task "${contract.name}" is already implemented. Call taskora.implement() at most once per task in a given process.`,
      );
    }

    // Resolve config — options override contract, contract overrides app defaults.
    const retry = options.retry ?? contract.retry ?? this.defaults.retry;
    const timeout =
      options.timeout ??
      (contract.timeout ? parseDuration(contract.timeout) : undefined) ??
      this.defaults.timeout ??
      30_000;
    const stall = options.stall ?? contract.stall ?? this.defaults.stall;
    const concurrency = options.concurrency ?? this.defaults.concurrency ?? 1;

    const ttl = options.ttl
      ? {
          maxMs: parseDuration(options.ttl.max),
          onExpire: (options.ttl.onExpire ?? "fail") as "fail" | "discard",
        }
      : undefined;

    const collect = options.collect
      ? {
          key: options.collect.key as ((data: unknown) => string) | string,
          delayMs: parseDuration(options.collect.delay),
          maxSize: options.collect.maxSize ?? 0,
          maxWaitMs: options.collect.maxWait ? parseDuration(options.collect.maxWait) : 0,
        }
      : undefined;

    const config: TaskConfig = {
      concurrency,
      timeout,
      retry,
      stall,
      singleton: options.singleton,
      concurrencyLimit: options.concurrencyLimit,
      ttl,
      collect,
      onCancel: options.onCancel,
    };

    const migrationConfig: TaskMigrationConfig | undefined =
      options.version !== undefined || options.since !== undefined || options.migrate !== undefined
        ? { version: options.version, since: options.since, migrate: options.migrate }
        : contract.version !== undefined
          ? { version: contract.version }
          : undefined;

    const middleware = options.middleware ?? [];

    if (existing) {
      // register() was called first — upgrade in place so existing BoundTask
      // references remain valid.
      existing._mergeImplementation({ handler, config, middleware, migrationConfig });
      return new BoundTask(existing);
    }

    const task = new Task<TInput, TOutput>(
      this.buildTaskDeps(),
      contract.name,
      handler,
      config,
      contract.input || contract.output
        ? { input: contract.input, output: contract.output }
        : undefined,
      migrationConfig,
      middleware,
    );

    this.tasks.set(contract.name, task as Task<unknown, unknown>);
    return new BoundTask(task);
  }

  /** @internal — build the TaskDeps bag shared by `task()`, `register()`, and `implement()`. */
  private buildTaskDeps(): TaskDeps {
    return {
      adapter: this.adapter,
      serializer: this.serializer,
      validateOnDispatch: this.validateOnDispatch,
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
    };
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

  /** @internal — used by TestRunner.importTask() */
  registerExternalTask(task: Task<unknown, unknown>): void {
    if (this.tasks.has(task.name)) {
      throw new Error(`Task "${task.name}" is already registered`);
    }
    this.tasks.set(task.name, task);
  }

  /** @internal — used by TestRunner({ from }) */
  getRegisteredTasks(): IterableIterator<Task<unknown, unknown>> {
    return this.tasks.values();
  }

  /** @internal — used by ScheduleManager */
  getScheduler(): Scheduler | null {
    return this.scheduler;
  }

  async ensureConnected(): Promise<void> {
    if (this.connected) return;
    await this.adapter.connect();

    // Wire-format handshake: refuse to proceed if the backend is already
    // occupied by an incompatible taskora version. This runs before workers,
    // scheduler, and even dispatch, so a misconfigured process fails fast
    // with a clear error instead of silently corrupting job state.
    const ours = currentMeta();
    const theirs = await this.adapter.handshake(ours);
    const verdict = checkCompat(ours, theirs);
    if (!verdict.ok) {
      // Don't leave the adapter half-connected when we refuse to proceed.
      // Otherwise the caller has no way to release blocking clients / sockets
      // the Redis backend opened inside `connect()`.
      try {
        await this.adapter.disconnect();
      } catch {
        // Best-effort cleanup — the original mismatch is the interesting error.
      }
      throw new SchemaVersionMismatchError(
        verdict.code,
        verdict.message,
        { wireVersion: ours.wireVersion, minCompat: ours.minCompat, writtenBy: ours.writtenBy },
        {
          wireVersion: theirs.wireVersion,
          minCompat: theirs.minCompat,
          writtenBy: theirs.writtenBy,
          writtenAt: theirs.writtenAt,
        },
      );
    }

    this.connected = true;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.ensureConnected();
    this.started = true;

    // Subscribe to event streams BEFORE starting workers
    // so XREVRANGE snapshots positions before any jobs are processed
    await this.ensureSubscription();

    for (const task of this.tasks.values()) {
      // Contract-only registrations: no handler in this process, skip the worker loop.
      // Dispatch and event subscription still work — this process is producer-only for this task.
      if (!task.hasHandler) continue;

      const worker = new Worker(
        task,
        this.adapter,
        this.serializer,
        this.retention,
        this.middlewares,
        task.config.onCancel,
        (info) => {
          if (task.hasEventListeners("failed") || this.appEmitter.hasListeners("task:failed")) {
            return;
          }
          const maxAttempts = info.maxAttempts > 1 ? `/${info.maxAttempts}` : "";
          const retry = info.willRetry ? ", will retry" : "";
          const stack =
            info.error instanceof Error && info.error.stack ? info.error.stack : String(info.error);
          console.error(
            `[taskora] task "${info.task}" job ${info.jobId} failed (attempt ${info.attempt}${maxAttempts}${retry})\n${stack}`,
          );
        },
      );
      this.workers.push(worker);
      await worker.start();
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
      case "cancelled": {
        const payload: Taskora.CancelledEvent = {
          id: jobId,
          reason: fields.reason || undefined,
        };
        task.dispatchEvent("cancelled", payload);
        this.appEmitter.emit("task:cancelled", { ...payload, task: raw.task });
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
