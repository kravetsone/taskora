import type { StandardSchemaV1 } from "@standard-schema/spec";
import { TypedEmitter } from "./emitter.js";
import { json } from "./serializer.js";
import { Task } from "./task.js";
import type { Taskora } from "./types.js";
import { Worker } from "./worker.js";

export interface TaskoraOptions {
  adapter: Taskora.Adapter;
  serializer?: Taskora.Serializer;
  defaults?: {
    retry?: Taskora.RetryConfig;
    timeout?: number;
    concurrency?: number;
  };
}

interface TaskOptionsBase {
  concurrency?: number;
  timeout?: number;
  retry?: Taskora.RetryConfig;
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

export class App {
  readonly adapter: Taskora.Adapter;
  readonly serializer: Taskora.Serializer;
  private readonly defaults: NonNullable<TaskoraOptions["defaults"]>;

  private tasks = new Map<string, Task<unknown, unknown>>();
  private workers: Worker[] = [];
  private connected = false;
  private started = false;

  private readonly appEmitter = new TypedEmitter<Taskora.AppEventMap>();
  private tasksNeedingEvents = new Set<string>();
  private unsubscribe: (() => Promise<void>) | null = null;
  private hasAppTaskListeners = false;

  constructor(options: TaskoraOptions) {
    this.adapter = options.adapter;
    this.serializer = options.serializer ?? json();
    this.defaults = options.defaults ?? {};
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

  task<TInput, TOutput>(
    name: string,
    handler: (data: TInput, ctx: Taskora.Context) => Promise<TOutput> | TOutput,
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
          handler: (data: TInput, ctx: Taskora.Context) => Promise<TOutput> | TOutput;
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
      { concurrency, timeout, retry },
      !isFunction ? { input: handlerOrOptions.input, output: handlerOrOptions.output } : undefined,
    );

    this.tasks.set(name, task as Task<unknown, unknown>);
    return task;
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
      const worker = new Worker(task, this.adapter, this.serializer);
      this.workers.push(worker);
      worker.start();
    }

    this.appEmitter.emit("worker:ready");
  }

  async close(options?: { timeout?: number }): Promise<void> {
    this.appEmitter.emit("worker:closing");

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
    }
  }
}
