import { randomUUID } from "node:crypto";
import { App } from "../app.js";
import { computeDelay, shouldRetry } from "../backoff.js";
import { createContext } from "../context.js";
import { RetryError, TimeoutError } from "../errors.js";
import { MemoryBackend } from "../memory/backend.js";
import { compose } from "../middleware.js";
import { runMigrations } from "../migration.js";
import type { ResultHandle } from "../result.js";
import type { Duration } from "../scheduler/duration.js";
import { parseDuration } from "../scheduler/duration.js";
import { validateSchema } from "../schema.js";
import { json } from "../serializer.js";
import { Task } from "../task.js";
import type { Taskora } from "../types.js";

export interface TestRunnerOptions {
  serializer?: Taskora.Serializer;
  /** Wrap an existing App — swaps all task adapters to in-memory. */
  from?: App;
}

export interface ExecutionResult<TOutput> {
  result: TOutput | undefined;
  state: Taskora.JobState;
  attempts: number;
  logs: Taskora.LogEntry[];
  progress: number | Record<string, unknown> | undefined;
  error: string | undefined;
  handle: ResultHandle<TOutput>;
}

const MAX_EXECUTE_LOOPS = 100;

export class TestRunner {
  readonly app: App;
  private readonly backend: MemoryBackend;
  private readonly serializer: Taskora.Serializer;
  private readonly restoreFns: Array<() => void> = [];
  private timeOffset = 0;
  private workflowSteps: Array<{ workflowId: string; nodeIndex: number; taskName: string; state: string }> = [];

  constructor(options?: TestRunnerOptions) {
    this.backend = new MemoryBackend({
      clock: () => Date.now() + this.timeOffset,
    });
    this.serializer = options?.serializer ?? json();

    if (options?.from) {
      // Patch all tasks on the source app to use the memory backend
      this.app = options.from;
      for (const task of this.app.getRegisteredTasks()) {
        const restore = task._patchDeps({
          adapter: this.backend,
          serializer: this.serializer,
          ensureConnected: () => Promise.resolve(),
        });
        this.restoreFns.push(restore);
      }
    } else {
      this.app = new App({
        adapter: this.backend,
        serializer: this.serializer,
      });
    }
  }

  /**
   * Execute a task handler directly with retry support.
   * Bypasses the queue — runs the handler inline and returns the result.
   */
  async run<TInput, TOutput>(task: Task<TInput, TOutput>, data: TInput): Promise<TOutput> {
    const retryConfig = task.config.retry;
    const maxAttempts = retryConfig?.attempts ?? 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();

      try {
        let processedData: unknown = data;

        if (task.inputSchema) {
          processedData = await validateSchema(task.inputSchema, processedData);
        }

        const ctx = createContext({
          id: randomUUID(),
          attempt,
          timestamp: this.now(),
          signal: controller.signal,
          onHeartbeat: () => {},
          onProgress: () => {},
          onLog: () => {},
        });

        const mwCtx: Taskora.MiddlewareContext = Object.assign(ctx, {
          task: { name: task.name },
          data: processedData,
          result: undefined as unknown,
        });

        const handlerMw: Taskora.Middleware = async (c) => {
          c.result = await task.handler(c.data as TInput, c);
        };
        const composed = compose([...task.middleware, handlerMw]);

        const timeoutMs = task.config.timeout;
        if (timeoutMs > 0 && timeoutMs < Number.POSITIVE_INFINITY) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              controller.abort("timeout");
              reject(new TimeoutError(ctx.id, timeoutMs));
            }, timeoutMs);
            composed(mwCtx).then(
              () => {
                clearTimeout(timer);
                resolve();
              },
              (err) => {
                clearTimeout(timer);
                reject(err);
              },
            );
          });
        } else {
          await composed(mwCtx);
        }

        let result = mwCtx.result as TOutput;
        if (task.outputSchema) {
          result = await validateSchema(task.outputSchema, result);
        }

        return result;
      } catch (err) {
        if (attempt >= maxAttempts) throw err;

        if (err instanceof RetryError) continue;

        if (err instanceof TimeoutError) {
          if (retryConfig?.retryOn && shouldRetry(err, attempt, retryConfig)) continue;
          throw err;
        }

        if (retryConfig && shouldRetry(err, attempt, retryConfig)) continue;

        throw err;
      }
    }

    throw new Error("Unreachable");
  }

  /**
   * Full queue pipeline: dispatch → process → auto-advance retries → return result + metadata.
   * Auto-imports the task if not already registered on `runner.app`.
   * Processes ALL tasks (including sub-tasks dispatched by the handler).
   */
  async execute<TInput, TOutput>(
    task: Task<TInput, TOutput>,
    data: TInput,
    options?: Taskora.DispatchOptions,
  ): Promise<ExecutionResult<TOutput>> {
    // Auto-register if needed
    if (!this.app.getTaskByName(task.name)) {
      if (this.restoreFns.length > 0) {
        // 'from' mode — task should already be on the app
        throw new Error(`Task "${task.name}" not found on the source app`);
      }
      this.importTask(task);
    }

    // Use the registered task (bound to memory adapter) for dispatch
    const target = this.app.getTaskByName(task.name) as unknown as Task<TInput, TOutput>;
    const handle = target.dispatch(data, options);
    await handle;

    // Process until the dispatched job reaches a terminal state
    for (let i = 0; i < MAX_EXECUTE_LOOPS; i++) {
      await this.processAll();
      const state = await this.backend.getState(task.name, handle.id);
      if (
        state === "completed" ||
        state === "failed" ||
        state === "cancelled" ||
        state === "expired"
      ) {
        break;
      }
      if (state === "retrying" || state === "delayed") {
        this.advanceToNextDelayed();
        continue;
      }
      break;
    }

    // Collect results
    const state = (await this.backend.getState(task.name, handle.id)) as Taskora.JobState;
    const rawResult = await this.backend.getResult(task.name, handle.id);
    const rawLogs = await this.backend.getLogs(task.name, handle.id);
    const rawProgress = await this.backend.getProgress(task.name, handle.id);
    const rawError = await this.backend.getError(task.name, handle.id);

    const result = rawResult ? (this.serializer.deserialize(rawResult) as TOutput) : undefined;
    const logs: Taskora.LogEntry[] = rawLogs.map((l) => JSON.parse(l));
    let progress: number | Record<string, unknown> | undefined;
    if (rawProgress) {
      const num = Number(rawProgress);
      progress = !Number.isNaN(num) && String(num) === rawProgress ? num : JSON.parse(rawProgress);
    }

    const details = await this.backend.getJobDetails(task.name, handle.id);
    const attempts = Number(details?.fields.attempt || 1);

    return { result, state, attempts, logs, progress, error: rawError ?? undefined, handle };
  }

  /**
   * Import a production task into the test runner.
   * Copies handler, config, middleware, schemas — rebinds to the memory adapter.
   * Returns a new Task registered on `runner.app`.
   * Not needed when using `createTestRunner({ from: app })`.
   */
  importTask<TInput, TOutput>(task: Task<TInput, TOutput>): Task<TInput, TOutput> {
    const migrationConfig =
      task.version > 1 || task.since > 1 || task.migrations.size > 0
        ? {
            version: task.version,
            since: task.since,
            migrate: Object.fromEntries(task.migrations) as Record<
              number,
              (data: unknown) => unknown
            >,
          }
        : undefined;

    const newTask = new Task<TInput, TOutput>(
      {
        adapter: this.backend,
        serializer: this.serializer,
        ensureConnected: () => this.app.ensureConnected(),
      },
      task.name,
      task.handler,
      task.config,
      { input: task.inputSchema, output: task.outputSchema },
      migrationConfig,
      task.middleware,
    );

    this.app.registerExternalTask(newTask as Task<unknown, unknown>);
    return newTask;
  }

  /**
   * Dispatch a job into the in-memory queue.
   * The task must be registered on `runner.app` (via `app.task()`, `importTask()`, or `from`).
   */
  dispatch<TInput, TOutput>(
    task: Task<TInput, TOutput>,
    data: TInput,
    options?: Taskora.DispatchOptions,
  ): ResultHandle<TOutput> {
    return task.dispatch(data, options);
  }

  /**
   * Advance virtual time, promote delayed jobs, and process all due work.
   */
  async advanceTime(duration: Duration | number): Promise<void> {
    const ms = typeof duration === "number" ? duration : parseDuration(duration as Duration);
    this.timeOffset += ms;
    this.backend.promoteAll();
    await this.processAll();
  }

  /**
   * Process all waiting jobs across all tasks until the queues are drained.
   */
  async processAll(): Promise<void> {
    let processed = true;
    while (processed) {
      processed = false;
      for (const taskName of this.backend.getTaskNames()) {
        const task = this.app.getTaskByName(taskName);
        if (!task) continue;
        if (await this.processOne(task)) processed = true;
      }
    }
  }

  /**
   * Force-flush collect buffers for a task and process resulting jobs.
   */
  async flush(task: Task<unknown, unknown>, key?: string): Promise<void> {
    this.backend.forceFlushCollect(task.name, key);
    await this.processAll();
  }

  /** All jobs with their current state. */
  get jobs() {
    return this.backend.getAllJobs();
  }

  /** Workflow step execution history. */
  get steps(): Array<{ workflowId: string; nodeIndex: number; taskName: string; state: string }> {
    return [...this.workflowSteps];
  }

  /** Reset all in-memory state between tests. */
  clear(): void {
    this.backend.clear();
    this.timeOffset = 0;
    this.workflowSteps = [];
  }

  /** Restore original adapters when using `from` mode. Call in afterEach. */
  dispose(): void {
    for (const restore of this.restoreFns) {
      restore();
    }
    this.restoreFns.length = 0;
    this.backend.clear();
    this.timeOffset = 0;
    this.workflowSteps = [];
  }

  // ── Workflow helpers ──

  private async advanceWorkflowStep(
    taskName: string,
    jobId: string,
    result: string,
    state: string,
  ): Promise<void> {
    try {
      const meta = await this.backend.getWorkflowMeta(taskName, jobId);
      if (!meta) return;

      this.workflowSteps.push({
        workflowId: meta.workflowId,
        nodeIndex: meta.nodeIndex,
        taskName,
        state,
      });

      const { toDispatch } = await this.backend.advanceWorkflow(
        meta.workflowId,
        meta.nodeIndex,
        result,
      );

      for (const node of toDispatch) {
        await this.backend.enqueue(node.taskName, node.jobId, node.data, {
          _v: node._v,
          _wf: meta.workflowId,
          _wfNode: node.nodeIndex,
        });
      }
    } catch {
      // Workflow advance failed
    }
  }

  private async failWorkflowStep(
    taskName: string,
    jobId: string,
    error: string,
  ): Promise<void> {
    try {
      const meta = await this.backend.getWorkflowMeta(taskName, jobId);
      if (!meta) return;

      this.workflowSteps.push({
        workflowId: meta.workflowId,
        nodeIndex: meta.nodeIndex,
        taskName,
        state: "failed",
      });

      const { activeJobIds } = await this.backend.failWorkflow(
        meta.workflowId,
        meta.nodeIndex,
        error,
      );

      for (const { task, jobId: jid } of activeJobIds) {
        try {
          await this.backend.cancel(task, jid, "workflow failed");
        } catch {}
      }
    } catch {
      // Workflow fail notification failed
    }
  }

  // ── Internal ──

  private now(): number {
    return Date.now() + this.timeOffset;
  }

  private advanceToNextDelayed(): void {
    const earliest = this.backend.getEarliestDelayedScore();
    if (earliest === null) return;
    const now = this.now();
    if (earliest > now) {
      this.timeOffset += earliest - now + 1;
    }
    this.backend.promoteAll();
  }

  private async processOne(task: Task<unknown, unknown>): Promise<boolean> {
    const token = randomUUID();
    const raw = await this.backend.dequeue(task.name, 30_000, token, {
      onExpire: task.config.ttl?.onExpire ?? "fail",
      singleton: task.config.singleton,
    });
    if (!raw) return false;

    const controller = new AbortController();
    let cancelUnsub: (() => void) | null = null;
    try {
      cancelUnsub = await this.backend.onCancel(task.name, (jobId) => {
        if (jobId === raw.id) controller.abort("cancelled");
      });
    } catch {}

    let handlerData: unknown;
    let ctx: Taskora.Context | undefined;

    try {
      const jobVersion = raw._v ?? 1;
      if (jobVersion > task.version) {
        await this.backend.nack(task.name, raw.id, token);
        return true;
      }
      if (jobVersion < task.since) {
        await this.backend.fail(
          task.name,
          raw.id,
          token,
          `Job version ${jobVersion} is below minimum supported version ${task.since}`,
        );
        return true;
      }

      handlerData = this.serializer.deserialize(raw.data);

      if (jobVersion < task.version) {
        handlerData = runMigrations(handlerData, jobVersion, task.version, task.migrations);
      }
      if (task.inputSchema && (task.version > 1 || task.migrations.size > 0)) {
        handlerData = await validateSchema(task.inputSchema, handlerData);
      }

      ctx = createContext({
        id: raw.id,
        attempt: raw.attempt,
        timestamp: raw.timestamp,
        signal: controller.signal,
        onHeartbeat: () => {
          this.backend
            .extendLock(task.name, raw.id, token, 30_000)
            .then((status) => {
              if (status === "cancelled") controller.abort("cancelled");
            })
            .catch(() => {});
        },
        onProgress: (value) => {
          this.backend.setProgress(task.name, raw.id, value).catch(() => {});
        },
        onLog: (entry) => {
          this.backend.addLog(task.name, raw.id, entry).catch(() => {});
        },
      });

      const mwCtx: Taskora.MiddlewareContext = Object.assign(ctx, {
        task: { name: task.name },
        data: handlerData,
        result: undefined as unknown,
      });

      const handlerMw: Taskora.Middleware = async (c) => {
        c.result = await task.handler(c.data, c);
      };
      const composed = compose([...task.middleware, handlerMw]);

      const timeoutMs = task.config.timeout;
      if (timeoutMs > 0 && timeoutMs < Number.POSITIVE_INFINITY) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            controller.abort("timeout");
            reject(new TimeoutError(raw.id, timeoutMs));
          }, timeoutMs);
          composed(mwCtx).then(
            () => {
              clearTimeout(timer);
              resolve();
            },
            (err) => {
              clearTimeout(timer);
              reject(err);
            },
          );
        });
      } else {
        await composed(mwCtx);
      }

      let handlerResult = mwCtx.result;
      if (task.outputSchema) {
        handlerResult = await validateSchema(task.outputSchema, handlerResult);
      }

      if (controller.signal.aborted && controller.signal.reason === "cancelled") {
        if (task.config.onCancel && ctx) {
          try {
            await task.config.onCancel(handlerData, ctx);
          } catch {}
        }
        await this.backend.finishCancel(task.name, raw.id, token);
        return true;
      }

      const serializedResult = this.serializer.serialize(handlerResult);
      await this.backend.ack(task.name, raw.id, token, serializedResult);

      // Advance workflow if part of one
      await this.advanceWorkflowStep(task.name, raw.id, serializedResult, "completed");
    } catch (err) {
      if (controller.signal.aborted && controller.signal.reason === "cancelled") {
        if (task.config.onCancel && ctx) {
          try {
            await task.config.onCancel(handlerData, ctx);
          } catch {}
        }
        await this.backend.finishCancel(task.name, raw.id, token);
        return true;
      }

      const errorMsg = err instanceof Error ? err.message : String(err);
      const retryConfig = task.config.retry;
      let retryInfo: { delay: number } | undefined;

      if (err instanceof TimeoutError) {
        if (retryConfig?.retryOn && shouldRetry(err, raw.attempt, retryConfig)) {
          retryInfo = { delay: computeDelay(raw.attempt, retryConfig) };
        }
      } else if (err instanceof RetryError) {
        if (!retryConfig || raw.attempt >= retryConfig.attempts) {
          retryInfo = undefined;
        } else {
          const delay =
            (err as RetryError).delay ??
            (retryConfig ? computeDelay(raw.attempt, retryConfig) : 1000);
          retryInfo = { delay };
        }
      } else if (retryConfig && shouldRetry(err, raw.attempt, retryConfig)) {
        retryInfo = { delay: computeDelay(raw.attempt, retryConfig) };
      }

      await this.backend.fail(task.name, raw.id, token, errorMsg, retryInfo);

      // Fail workflow on permanent failure
      if (!retryInfo) {
        await this.failWorkflowStep(task.name, raw.id, errorMsg);
      }
    } finally {
      if (cancelUnsub) cancelUnsub();
    }

    return true;
  }
}

export function createTestRunner(options?: TestRunnerOptions): TestRunner {
  return new TestRunner(options);
}
