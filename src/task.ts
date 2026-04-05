import { randomUUID } from "node:crypto";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { TypedEmitter } from "./emitter.js";
import { ResultHandle } from "./result.js";
import { validateSchema } from "./schema.js";
import type { Taskora } from "./types.js";

export interface TaskConfig {
  concurrency: number;
  timeout: number;
  retry?: Taskora.RetryConfig;
}

export interface TaskDeps {
  adapter: Taskora.Adapter;
  serializer: Taskora.Serializer;
  ensureConnected: () => Promise<void>;
  onEventSubscribe?: (taskName: string) => void;
}

export class Task<TInput, TOutput> {
  readonly name: string;
  readonly handler: (data: TInput, ctx: Taskora.Context) => Promise<TOutput> | TOutput;
  readonly config: TaskConfig;
  readonly inputSchema?: StandardSchemaV1<unknown, TInput>;
  readonly outputSchema?: StandardSchemaV1<unknown, TOutput>;
  private readonly deps: TaskDeps;
  private readonly emitter = new TypedEmitter<Taskora.TaskEventMap<TOutput>>();

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

  on<K extends keyof Taskora.TaskEventMap<TOutput> & string>(
    event: K,
    handler: (data: Taskora.TaskEventMap<TOutput>[K]) => void,
  ): () => void {
    const unsub = this.emitter.on(event, handler);
    this.deps.onEventSubscribe?.(this.name);
    return unsub;
  }

  /** @internal — used by App to dispatch stream events */
  dispatchEvent(event: string, data: unknown): void {
    this.emitter.emit(event, data);
  }

  hasEventListeners(): boolean {
    return this.emitter.hasListeners();
  }

  dispatch(data: TInput, options?: Taskora.JobOptions): ResultHandle<TOutput> {
    const id = randomUUID();
    const enqueuePromise = (async () => {
      await this.deps.ensureConnected();
      if (this.inputSchema) {
        await validateSchema(this.inputSchema, data);
      }
      const serialized = this.deps.serializer.serialize(data);
      await this.deps.adapter.enqueue(this.name, id, serialized, {
        _v: 1,
        maxAttempts: this.config.retry?.attempts,
        ...options,
      });
    })();

    return new ResultHandle<TOutput>(
      id,
      this.name,
      this.deps.adapter,
      this.deps.serializer,
      enqueuePromise,
    );
  }

  dispatchMany(
    jobs: Array<{ data: TInput; options?: Taskora.JobOptions }>,
  ): ResultHandle<TOutput>[] {
    return jobs.map((job) => this.dispatch(job.data, job.options));
  }
}
