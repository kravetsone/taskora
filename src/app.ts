import type { StandardSchemaV1 } from "@standard-schema/spec";
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

  constructor(options: TaskoraOptions) {
    this.adapter = options.adapter;
    this.serializer = options.serializer ?? json();
    this.defaults = options.defaults ?? {};
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

    for (const task of this.tasks.values()) {
      const worker = new Worker(task, this.adapter, this.serializer);
      this.workers.push(worker);
      worker.start();
    }

    this.started = true;
  }

  async close(options?: { timeout?: number }): Promise<void> {
    const stopPromises = this.workers.map((w) => w.stop(options?.timeout));
    await Promise.allSettled(stopPromises);
    this.workers = [];
    this.started = false;

    if (this.connected) {
      await this.adapter.disconnect();
      this.connected = false;
    }
  }
}
