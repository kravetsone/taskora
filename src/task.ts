import { randomUUID } from "node:crypto";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { TypedEmitter } from "./emitter.js";
import { DuplicateJobError, ThrottledError } from "./errors.js";
import { type ResolvedVersion, normalizeMigrations, resolveVersion } from "./migration.js";
import { ResultHandle } from "./result.js";
import { parseDuration } from "./scheduler/duration.js";
import { validateSchema } from "./schema.js";
import type { Taskora } from "./types.js";
import { chain as chainFn } from "./workflow/chain.js";
import { group as groupFn } from "./workflow/group.js";
import type { WorkflowHandle } from "./workflow/handle.js";
import { type AnySignature, Signature } from "./workflow/signature.js";

// Process-monotonic dispatch counter. Captured synchronously at each
// `task.dispatch()` call site, before the async enqueue IIFE starts — so
// parallel dispatches that race inside the async path still carry the
// original call order in their `seq` field. This is what the inspector sorts
// by for deterministic FIFO display.
//
// Verified: tests/integration/inspector-dlq.test.ts > waiting() returns
// enqueued jobs. Without synchronous capture, ioredis's internal command
// ordering and BunDriver's pure LPUSH semantics produced different raw orders
// for the same dispatch sequence.
let _dispatchSeq = 0;

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
  /**
   * App-level default for whether `dispatch()` validates input via the task's
   * Standard Schema before enqueueing. Per-call `dispatchOptions.skipValidation`
   * overrides this. Default `true`.
   */
  validateOnDispatch: boolean;
}

export class Task<TInput, TOutput> {
  readonly name: string;
  /**
   * Fields below are conceptually readonly for external consumers but are
   * mutable internally so that {@link Task._mergeImplementation} can upgrade
   * a contract-only registration with a real handler and worker-side config.
   * Do not mutate these from outside the class.
   */
  handler: (data: TInput, ctx: Taskora.Context) => Promise<TOutput> | TOutput;
  config: TaskConfig;
  inputSchema?: StandardSchemaV1<unknown, TInput>;
  outputSchema?: StandardSchemaV1<unknown, TOutput>;
  version: number;
  since: number;
  migrations: Map<number, MigrationFn>;
  middleware: Taskora.Middleware[];
  /**
   * `true` if a real handler is attached and this process should run a worker
   * loop for this task. `false` for contract-only registrations (`app.register`)
   * where the handler lives in a separate process.
   */
  hasHandler = true;
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

  /** @internal — used by workflow dispatch to extract adapter/serializer */
  _getDeps(): TaskDeps {
    return this.deps;
  }

  /**
   * @internal — called by {@link App.implement} to upgrade a contract-only
   * registration (`register()` result) with a real handler and worker-side
   * configuration. Merges only the fields that make sense to override
   * post-registration; leaves `name` and existing schemas intact unless
   * explicitly replaced.
   */
  _mergeImplementation(opts: {
    handler: (data: TInput, ctx: Taskora.Context) => Promise<TOutput> | TOutput;
    config?: Partial<TaskConfig>;
    middleware?: Taskora.Middleware[];
    migrationConfig?: TaskMigrationConfig;
  }): void {
    this.handler = opts.handler;
    if (opts.config) {
      this.config = { ...this.config, ...opts.config };
    }
    if (opts.middleware !== undefined) {
      this.middleware = opts.middleware;
    }
    if (opts.migrationConfig) {
      const resolved: ResolvedVersion = resolveVersion(opts.migrationConfig);
      this.version = resolved.version;
      this.since = resolved.since;
      this.migrations = normalizeMigrations(opts.migrationConfig.migrate, resolved.since);
    }
    this.hasHandler = true;
  }

  /** Create a Signature — a composable snapshot of this task invocation. */
  s(data?: TInput): Signature<TInput, TOutput> {
    return new Signature(this, data);
  }

  /** Dispatch one job per item in parallel. Sugar for group(...items.map(i => task.s(i))). */
  map(items: TInput[]): WorkflowHandle<TOutput[]> {
    const sigs = items.map((item) => this.s(item));
    return groupFn(...sigs).dispatch() as WorkflowHandle<TOutput[]>;
  }

  /** Split items into chunks, process each chunk as a parallel group, chunks run sequentially. */
  chunk(items: TInput[], options: { size: number }): WorkflowHandle<TOutput[]> {
    const chunks: AnySignature[] = [];
    for (let i = 0; i < items.length; i += options.size) {
      const slice = items.slice(i, i + options.size);
      const sigs = slice.map((item) => this.s(item));
      chunks.push(groupFn(...sigs));
    }
    if (chunks.length === 1) return chunks[0].dispatch() as WorkflowHandle<TOutput[]>;
    return chainFn(...chunks).dispatch() as WorkflowHandle<TOutput[]>;
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

  hasEventListeners(event?: string): boolean {
    return this.emitter.hasListeners(event);
  }

  dispatch(data: TInput, options?: Taskora.DispatchOptions): ResultHandle<TOutput> {
    const id = randomUUID();

    // Capture dispatch wall-clock and monotonic sequence SYNCHRONOUSLY, before
    // the async IIFE yields. This guarantees that `inspector.waiting()` can
    // display jobs in dispatch call order even when multiple dispatches race
    // through the async pipeline (connect, validate, serialize) and arrive at
    // the Redis server in a driver-dependent order.
    const dispatchTs = Date.now();
    const dispatchSeq = ++_dispatchSeq;

    // Validation is enabled globally (TaskoraOptions.validateOnDispatch, default
    // true) and can be disabled per-call via options.skipValidation.
    const shouldValidate = this.deps.validateOnDispatch && options?.skipValidation !== true;

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
          if (shouldValidate && this.inputSchema) {
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
        if (shouldValidate && this.inputSchema) {
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
          ts: dispatchTs,
          seq: dispatchSeq,
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
