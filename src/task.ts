import { randomUUID } from "node:crypto";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { TypedEmitter } from "./emitter.js";
import { DuplicateJobError, ThrottledError } from "./errors.js";
import { type ResolvedVersion, normalizeMigrations, resolveVersion } from "./migration.js";
import { ResultHandle } from "./result.js";
import { parseDuration } from "./scheduler/duration.js";
import { validateSchema } from "./schema.js";
import type { Taskora } from "./types.js";

type MigrationFn = (data: unknown) => unknown;

export interface CollectConfigResolved {
  key: ((data: unknown) => string) | string;
  delayMs: number;
  maxSize: number;
  maxWaitMs: number;
}

export interface TaskConfig {
  concurrency: number;
  timeout: number;
  retry?: Taskora.RetryConfig;
  stall?: Taskora.StallConfig;
  singleton?: boolean;
  concurrencyLimit?: number;
  ttl?: { maxMs: number; onExpire: "fail" | "discard" };
  collect?: CollectConfigResolved;
  onCancel?: (data: unknown, ctx: Taskora.Context) => Promise<void> | void;
}

export interface TaskMigrationConfig {
  version?: number;
  since?: number;
  migrate?: readonly MigrationFn[] | Record<number, MigrationFn>;
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
  readonly version: number;
  readonly since: number;
  readonly migrations: Map<number, MigrationFn>;
  readonly middleware: Taskora.Middleware[];
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
    migrationConfig?: TaskMigrationConfig,
    middleware?: Taskora.Middleware[],
  ) {
    this.deps = deps;
    this.name = name;
    this.handler = handler;
    this.config = config;
    this.inputSchema = schemas?.input;
    this.outputSchema = schemas?.output;

    const resolved: ResolvedVersion = migrationConfig
      ? resolveVersion(migrationConfig)
      : { version: 1, since: 1 };
    this.version = resolved.version;
    this.since = resolved.since;
    this.migrations = normalizeMigrations(migrationConfig?.migrate, resolved.since);
    this.middleware = middleware ?? [];
  }

  /** @internal — used by TestRunner to swap adapter for testing */
  _patchDeps(patch: Partial<TaskDeps>): () => void {
    const saved: Partial<Record<keyof TaskDeps, unknown>> = {};
    for (const key of Object.keys(patch) as Array<keyof TaskDeps>) {
      saved[key] = this.deps[key];
      (this.deps as Record<string, unknown>)[key] = patch[key];
    }
    return () => {
      for (const key of Object.keys(saved) as Array<keyof TaskDeps>) {
        (this.deps as Record<string, unknown>)[key] = saved[key];
      }
    };
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

  dispatch(data: TInput, options?: Taskora.DispatchOptions): ResultHandle<TOutput> {
    const id = randomUUID();

    // Collect tasks use a simplified dispatch path
    if (this.config.collect) {
      const collect = this.config.collect;
      const handle = new ResultHandle<TOutput>(
        id,
        this.name,
        this.deps.adapter,
        this.deps.serializer,
        (async () => {
          await this.deps.ensureConnected();
          if (this.inputSchema) {
            await validateSchema(this.inputSchema, data);
          }
          const serialized = this.deps.serializer.serialize(data);
          const collectKey = typeof collect.key === "function" ? collect.key(data) : collect.key;

          await this.deps.adapter.collectPush(this.name, id, serialized, {
            _v: this.version,
            maxAttempts: this.config.retry?.attempts,
            collectKey,
            delayMs: collect.delayMs,
            maxSize: collect.maxSize,
            maxWaitMs: collect.maxWaitMs,
          });
        })(),
      );
      return handle;
    }

    const handle = new ResultHandle<TOutput>(
      id,
      this.name,
      this.deps.adapter,
      this.deps.serializer,
      (async () => {
        await this.deps.ensureConnected();
        if (this.inputSchema) {
          await validateSchema(this.inputSchema, data);
        }
        const serialized = this.deps.serializer.serialize(data);

        // Compute TTL expireAt
        const ttlMs = options?.ttl
          ? parseDuration(options.ttl)
          : this.config.ttl
            ? this.config.ttl.maxMs
            : 0;
        const expireAt = ttlMs > 0 ? Date.now() + ttlMs : 0;

        // Concurrency per key
        const concurrencyKey = options?.concurrencyKey;
        const concurrencyLimit = concurrencyKey
          ? (options?.concurrencyLimit ?? this.config.concurrencyLimit ?? 1)
          : 0;

        const baseOpts = {
          _v: this.version,
          maxAttempts: this.config.retry?.attempts,
          priority: options?.priority,
          expireAt: expireAt || undefined,
          concurrencyKey,
          concurrencyLimit: concurrencyLimit || undefined,
        };

        if (options?.debounce) {
          const delayMs = parseDuration(options.debounce.delay);
          await this.deps.adapter.debounceEnqueue(
            this.name,
            id,
            serialized,
            baseOpts,
            options.debounce.key,
            delayMs,
          );
          return;
        }

        if (options?.throttle) {
          const windowMs = parseDuration(options.throttle.window);
          const ok = await this.deps.adapter.throttleEnqueue(
            this.name,
            id,
            serialized,
            { ...baseOpts, delay: options.delay },
            options.throttle.key,
            options.throttle.max,
            windowMs,
          );
          if (!ok) {
            handle.enqueued = false;
            if (options.throwOnReject) {
              throw new ThrottledError(id, options.throttle.key);
            }
            return;
          }
          return;
        }

        if (options?.deduplicate) {
          const states = options.deduplicate.while ?? ["waiting", "delayed", "active"];
          const result = await this.deps.adapter.deduplicateEnqueue(
            this.name,
            id,
            serialized,
            { ...baseOpts, delay: options.delay },
            options.deduplicate.key,
            states,
          );
          if (!result.created) {
            handle.enqueued = false;
            handle.existingId = result.existingId;
            if (options.throwOnReject) {
              throw new DuplicateJobError(id, options.deduplicate.key, result.existingId);
            }
            return;
          }
          return;
        }

        await this.deps.adapter.enqueue(this.name, id, serialized, {
          ...baseOpts,
          delay: options?.delay,
        });
      })(),
    );

    return handle;
  }

  dispatchMany(
    jobs: Array<{ data: TInput; options?: Taskora.DispatchOptions }>,
  ): ResultHandle<TOutput>[] {
    return jobs.map((job) => this.dispatch(job.data, job.options));
  }
}
