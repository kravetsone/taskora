import type { Taskora } from "./types.js";

export interface TaskConfig {
  concurrency: number;
  timeout: number;
}

export interface TaskDeps {
  adapter: Taskora.Adapter;
  serializer: Taskora.Serializer;
  ensureConnected: () => Promise<void>;
}

export class Task<TInput, TOutput> {
  readonly name: string;
  readonly handler: (data: TInput, ctx: Taskora.Context) => Promise<TOutput> | TOutput;
  readonly config: TaskConfig;
  private readonly deps: TaskDeps;

  constructor(
    deps: TaskDeps,
    name: string,
    handler: (data: TInput, ctx: Taskora.Context) => Promise<TOutput> | TOutput,
    config: TaskConfig,
  ) {
    this.deps = deps;
    this.name = name;
    this.handler = handler;
    this.config = config;
  }

  async dispatch(data: TInput, options?: Taskora.JobOptions): Promise<string> {
    await this.deps.ensureConnected();
    const serialized = this.deps.serializer.serialize(data);
    return this.deps.adapter.enqueue(this.name, serialized, {
      _v: 1,
      ...options,
    });
  }

  async dispatchMany(
    jobs: Array<{ data: TInput; options?: Taskora.JobOptions }>,
  ): Promise<string[]> {
    await this.deps.ensureConnected();
    const ids: string[] = [];
    for (const job of jobs) {
      const id = await this.dispatch(job.data, job.options);
      ids.push(id);
    }
    return ids;
  }
}
