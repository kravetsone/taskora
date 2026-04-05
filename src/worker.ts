import { randomUUID } from "node:crypto";
import { computeDelay, shouldRetry } from "./backoff.js";
import { createContext } from "./context.js";
import { RetryError, TimeoutError } from "./errors.js";
import { validateSchema } from "./schema.js";
import type { Task } from "./task.js";
import type { Taskora } from "./types.js";

const LOCK_TTL = 30_000;
const LOCK_EXTEND_INTERVAL = 10_000;
const BACKOFF_MIN = 50;
const BACKOFF_MAX = 1_000;
const BACKOFF_FACTOR = 2;

interface ActiveJob {
  promise: Promise<void>;
  token: string;
  controller: AbortController;
}

export class Worker {
  private readonly task: Task<unknown, unknown>;
  private readonly adapter: Taskora.Adapter;
  private readonly serializer: Taskora.Serializer;
  private readonly concurrency: number;

  private running = false;
  private activeJobs = new Map<string, ActiveJob>();
  private lockTimer: ReturnType<typeof setInterval> | null = null;
  private backoffMs = BACKOFF_MIN;
  private slotResolve: (() => void) | null = null;

  constructor(
    task: Task<unknown, unknown>,
    adapter: Taskora.Adapter,
    serializer: Taskora.Serializer,
  ) {
    this.task = task;
    this.adapter = adapter;
    this.serializer = serializer;
    this.concurrency = task.config.concurrency;
  }

  start(): void {
    this.running = true;
    this.lockTimer = setInterval(() => this.extendAllLocks(), LOCK_EXTEND_INTERVAL);
    this.poll();
  }

  async stop(timeout?: number): Promise<void> {
    this.running = false;

    if (this.lockTimer) {
      clearInterval(this.lockTimer);
      this.lockTimer = null;
    }

    // Wake up the poll loop if it's waiting for a slot
    if (this.slotResolve) {
      this.slotResolve();
      this.slotResolve = null;
    }

    // Signal all active jobs to wrap up
    for (const job of this.activeJobs.values()) {
      job.controller.abort();
    }

    // Wait for active jobs to finish
    const promises = [...this.activeJobs.values()].map((j) => j.promise);
    if (promises.length > 0) {
      if (timeout != null) {
        await Promise.race([
          Promise.allSettled(promises),
          new Promise<void>((resolve) => setTimeout(resolve, timeout)),
        ]);
      } else {
        await Promise.allSettled(promises);
      }
    }
  }

  private async poll(): Promise<void> {
    while (this.running) {
      // Wait for a free slot if at capacity
      if (this.activeJobs.size >= this.concurrency) {
        await new Promise<void>((resolve) => {
          this.slotResolve = resolve;
        });
        if (!this.running) break;
        continue;
      }

      try {
        const token = randomUUID();
        const result = await this.adapter.dequeue(this.task.name, LOCK_TTL, token);

        if (!result) {
          await this.sleep(this.backoffMs);
          this.backoffMs = Math.min(this.backoffMs * BACKOFF_FACTOR, BACKOFF_MAX);
          continue;
        }

        this.backoffMs = BACKOFF_MIN;
        this.processJob(result, token);
      } catch {
        // Dequeue error — back off and retry
        await this.sleep(this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * BACKOFF_FACTOR, BACKOFF_MAX);
      }
    }
  }

  private processJob(raw: Taskora.DequeueResult, token: string): void {
    const controller = new AbortController();

    const promise = (async () => {
      let handlerResult: unknown;
      try {
        const data = this.serializer.deserialize(raw.data);
        const ctx = createContext({
          id: raw.id,
          attempt: raw.attempt,
          timestamp: raw.timestamp,
          signal: controller.signal,
          onHeartbeat: () => {
            this.adapter.extendLock(this.task.name, raw.id, token, LOCK_TTL).catch(() => {});
          },
          onProgress: (value) => {
            this.adapter.setProgress(this.task.name, raw.id, value).catch(() => {});
          },
          onLog: (entry) => {
            this.adapter.addLog(this.task.name, raw.id, entry).catch(() => {});
          },
        });

        const timeoutMs = this.task.config.timeout;
        if (timeoutMs > 0 && timeoutMs < Number.POSITIVE_INFINITY) {
          handlerResult = await new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
              controller.abort("timeout");
              reject(new TimeoutError(raw.id, timeoutMs));
            }, timeoutMs);
            Promise.resolve(this.task.handler(data, ctx)).then(
              (result) => {
                clearTimeout(timer);
                resolve(result);
              },
              (err) => {
                clearTimeout(timer);
                reject(err);
              },
            );
          });
        } else {
          handlerResult = await this.task.handler(data, ctx);
        }
        if (this.task.outputSchema) {
          handlerResult = await validateSchema(this.task.outputSchema, handlerResult);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const retryConfig = this.task.config.retry;
        let retryInfo: { delay: number } | undefined;

        if (err instanceof TimeoutError) {
          // Timeout errors are not retried by default —
          // user must add TimeoutError to retryOn explicitly
          if (retryConfig?.retryOn && shouldRetry(err, raw.attempt, retryConfig)) {
            retryInfo = { delay: computeDelay(raw.attempt, retryConfig) };
          }
        } else if (err instanceof RetryError) {
          // Manual retry via ctx.retry() or throw new RetryError()
          // Always retry unless attempts exhausted
          if (!retryConfig || raw.attempt >= retryConfig.attempts) {
            retryInfo = undefined;
          } else {
            const delay =
              err.delay ?? (retryConfig ? computeDelay(raw.attempt, retryConfig) : 1000);
            retryInfo = { delay };
          }
        } else if (retryConfig && shouldRetry(err, raw.attempt, retryConfig)) {
          retryInfo = { delay: computeDelay(raw.attempt, retryConfig) };
        }

        try {
          await this.adapter.fail(this.task.name, raw.id, token, errorMsg, retryInfo);
        } catch {
          // fail() itself failed (e.g. lock expired)
        }
        return;
      }

      // Handler succeeded — ack the job
      try {
        const serializedResult = this.serializer.serialize(handlerResult);
        await this.adapter.ack(this.task.name, raw.id, token, serializedResult);
      } catch {
        // ack failed (e.g. lock expired) — job may be retried by stall detection
      }
    })();

    const tracked = promise.finally(() => {
      this.activeJobs.delete(raw.id);
      if (this.slotResolve) {
        this.slotResolve();
        this.slotResolve = null;
      }
    });

    this.activeJobs.set(raw.id, { promise: tracked, token, controller });
  }

  private async extendAllLocks(): Promise<void> {
    for (const [jobId, { token }] of this.activeJobs) {
      try {
        await this.adapter.extendLock(this.task.name, jobId, token, LOCK_TTL);
      } catch {
        // Extension failed — lock may have expired
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
