import type { StandardSchemaV1 } from "@standard-schema/spec";
import { validateSchema } from "./schema.js";
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
  readonly inputSchema?: StandardSchemaV1<unknown, TInput>;
  readonly outputSchema?: StandardSchemaV1<unknown, TOutput>;
  private readonly deps: TaskDeps;

  constructor(
    deps: TaskDeps,
    name: string,
    handler: (data: TInput, ctx: Taskora.Context) => Promise<TOutput> | TOutput,
    config: TaskConfig,
    schemas?: {
      input?: StandardSchemaV1<unknown, TInput>;
      output?: StandardSchemaV1<unknown, TOutput>;
    },
  ) {
    this.deps = deps;
    this.name = name;
    this.handler = handler;
    this.config = config;
    this.inputSchema = schemas?.input;
    this.outputSchema = schemas?.output;
  }

  async dispatch(data: TInput, options?: Taskora.JobOptions): Promise<string> {
    await this.deps.ensureConnected();
    if (this.inputSchema) {
      await validateSchema(this.inputSchema, data);
    }
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
