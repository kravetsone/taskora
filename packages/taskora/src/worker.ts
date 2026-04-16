import { randomUUID } from "node:crypto";
import { computeDelay, shouldRetry } from "./backoff.js";
import { createContext } from "./context.js";
import { RetryError, TimeoutError } from "./errors.js";
import { compose } from "./middleware.js";
import { runMigrations } from "./migration.js";
import { validateSchema } from "./schema.js";
import type { Task } from "./task.js";
import type { Taskora } from "./types.js";

const LOCK_TTL = 30_000;
const LOCK_EXTEND_INTERVAL = 10_000;
const BLOCK_TIMEOUT = 2_000;
const DEFAULT_STALL_INTERVAL = 30_000;
const DEFAULT_MAX_STALLED_COUNT = 1;

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
  private readonly stallInterval: number;
  private readonly maxStalledCount: number;
  private readonly retention: {
    completed: { maxAgeMs: number; maxItems: number };
    failed: { maxAgeMs: number; maxItems: number };
  };
  private readonly composed: (ctx: Taskora.MiddlewareContext) => Promise<void>;
  private readonly dequeueOptions: Taskora.DequeueOptions;
  private readonly onCancel?: (data: unknown, ctx: Taskora.Context) => Promise<void> | void;
  private readonly onJobError?: (info: {
    task: string;
    jobId: string;
    error: unknown;
    attempt: number;
    maxAttempts: number;
    willRetry: boolean;
  }) => void;

  private running = false;
  private activeJobs = new Map<string, ActiveJob>();
  private lockTimer: ReturnType<typeof setInterval> | null = null;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private slotResolve: (() => void) | null = null;
  private unsubCancel: (() => void) | null = null;

  constructor(
    task: Task<unknown, unknown>,
    adapter: Taskora.Adapter,
    serializer: Taskora.Serializer,
    retention: {
      completed: { maxAgeMs: number; maxItems: number };
      failed: { maxAgeMs: number; maxItems: number };
    },
    appMiddleware?: Taskora.Middleware[],
    onCancel?: (data: unknown, ctx: Taskora.Context) => Promise<void> | void,
    onJobError?: (info: {
      task: string;
      jobId: string;
      error: unknown;
      attempt: number;
      maxAttempts: number;
      willRetry: boolean;
    }) => void,
  ) {
    this.task = task;
    this.adapter = adapter;
    this.serializer = serializer;
    this.concurrency = task.config.concurrency;
    this.stallInterval = task.config.stall?.interval ?? DEFAULT_STALL_INTERVAL;
    this.maxStalledCount = task.config.stall?.maxCount ?? DEFAULT_MAX_STALLED_COUNT;
    this.retention = retention;
    this.onCancel = onCancel;
    this.onJobError = onJobError;
    this.dequeueOptions = {
      onExpire: task.config.ttl?.onExpire ?? "fail",
      singleton: task.config.singleton,
    };

    // Compose once: app middleware → task middleware → handler
    const handlerMw: Taskora.Middleware = async (ctx) => {
      ctx.result = await this.task.handler(ctx.data, ctx);
    };
    const chain = [...(appMiddleware ?? []), ...task.middleware, handlerMw];
    this.composed = compose(chain);
  }

  async start(): Promise<void> {
    this.running = true;
    this.lockTimer = setInterval(() => this.extendAllLocks(), LOCK_EXTEND_INTERVAL);
    this.stallTimer = setInterval(() => this.runStalledCheck(), this.stallInterval);
    try {
      this.unsubCancel = await this.adapter.onCancel(this.task.name, (jobId) => {
        const job = this.activeJobs.get(jobId);
        if (job) job.controller.abort("cancelled");
      });
    } catch {
      // Subscription failed — fall back to extendLock-based detection
    }
    this.poll();
  }

  async stop(timeout?: number): Promise<void> {
    this.running = false;

    if (this.lockTimer) {
      clearInterval(this.lockTimer);
      this.lockTimer = null;
    }
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
    if (this.unsubCancel) {
      this.unsubCancel();
      this.unsubCancel = null;
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
      if (this.activeJobs.size >= this.concurrency) {
        await new Promise<void>((resolve) => {
          this.slotResolve = resolve;
        });
        if (!this.running) break;
        continue;
      }

      try {
        const token = randomUUID();
        const result = await this.adapter.blockingDequeue(
          this.task.name,
          LOCK_TTL,
          token,
          BLOCK_TIMEOUT,
          this.dequeueOptions,
        );

        if (!result) continue;
        this.processJob(result, token);
      } catch {
        if (!this.running) break;
      }
    }
  }

  private processJob(initialRaw: Taskora.DequeueResult, initialToken: string): void {
    // ── Self-feeding slot ────────────────────────────────────────────
    //
    // Each call to processJob() represents one concurrency slot. Instead of
    // returning after one job and asking the poll loop to refill the slot,
    // the while loop below self-feeds: on successful ack/fail the adapter
    // atomically dequeues the next job (via `ackAndDequeue`/`failAndDequeue`)
    // and we keep going inside the same slot promise.
    //
    // This eliminates the serial-poll-loop bottleneck at high concurrency —
    // each of the N slots pipelines ack+dequeue independently instead of
    // funneling ack, then blockingDequeue, then ack, through one loop.
    //
    // `currentRaw` / `currentToken` / `currentController` mutate across
    // iterations so the closures captured by `extendAllLocks` and the cancel
    // subscription always see the job currently being processed in this slot.
    let currentRaw = initialRaw;
    let currentToken = initialToken;
    let currentController = new AbortController();

    // Forward-declared so the loop body can install it in activeJobs entries
    // when transitioning mid-chain. Safe: the loop body only reads `tracked`
    // after its first await (by which time the assignment below has run).
    // biome-ignore lint/style/useConst: definite-assignment forward reference
    let tracked!: Promise<void>;

    const promise = (async () => {
      while (true) {
        const raw = currentRaw;
        const token = currentToken;
        const controller = currentController;

        // ── Version checks ────────────────────────────────────────
        const jobVersion = raw._v ?? 1;
        const taskVersion = this.task.version;

        // Future version — nack silently, leave for a newer worker.
        // Don't self-feed: the nacked job could pop right back.
        if (jobVersion > taskVersion) {
          try {
            await this.adapter.nack(this.task.name, raw.id, token);
          } catch {
            // nack failed (e.g. lock expired)
          }
          break;
        }

        // Expired version — fail permanently, migration code is gone
        if (jobVersion < this.task.since) {
          const msg = `Job version ${jobVersion} is below minimum supported version ${this.task.since} — migration no longer available`;
          try {
            await this.adapter.fail(this.task.name, raw.id, token, msg);
          } catch {
            // fail() itself failed
          }
          break;
        }

        let handlerResult: unknown;
        let data: unknown;
        let ctx: Taskora.Context | undefined;
        // In-flight progress/log writes kicked off by the handler via
        // ctx.progress / ctx.log. They are fire-and-forget from the handler's
        // perspective (ctx.progress returns void) but the worker MUST await
        // them before the terminal ack/fail — otherwise the "progress" XADD
        // can land in the Redis stream after the "completed" XADD, and any
        // consumer that clears state on the terminal event would then receive
        // stale progress events. See events.test.ts > "task event ordering".
        const pendingWrites: Promise<unknown>[] = [];
        const flushPendingWrites = async () => {
          if (pendingWrites.length === 0) return;
          const snapshot = pendingWrites.splice(0, pendingWrites.length);
          await Promise.allSettled(snapshot);
        };

        try {
          data = this.serializer.deserialize(raw.data);

          // ── Migration + validation ──────────────────────────────
          if (jobVersion < taskVersion) {
            data = runMigrations(data, jobVersion, taskVersion, this.task.migrations);
          }

          // Validate input after migration (applies .default() values)
          // Only for versioned tasks (version > 1 or has migrations)
          if (this.task.inputSchema && (taskVersion > 1 || this.task.migrations.size > 0)) {
            data = await validateSchema(this.task.inputSchema, data);
          }

          ctx = createContext({
            id: raw.id,
            attempt: raw.attempt,
            timestamp: raw.timestamp,
            signal: controller.signal,
            onHeartbeat: () => {
              this.adapter
                .extendLock(this.task.name, raw.id, token, LOCK_TTL)
                .then((status) => {
                  if (status === "cancelled") controller.abort("cancelled");
                })
                .catch(() => {});
            },
            onProgress: (value) => {
              pendingWrites.push(
                this.adapter.setProgress(this.task.name, raw.id, value).catch(() => {}),
              );
            },
            onLog: (entry) => {
              pendingWrites.push(
                this.adapter.addLog(this.task.name, raw.id, entry).catch(() => {}),
              );
            },
          });

          // Build middleware context (superset of Context)
          const mwCtx: Taskora.MiddlewareContext = Object.assign(ctx, {
            task: { name: this.task.name },
            data,
            result: undefined as unknown,
          });

          const timeoutMs = this.task.config.timeout;
          if (timeoutMs > 0 && timeoutMs < Number.POSITIVE_INFINITY) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => {
                controller.abort("timeout");
                reject(new TimeoutError(raw.id, timeoutMs));
              }, timeoutMs);
              this.composed(mwCtx).then(
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
            await this.composed(mwCtx);
          }
          handlerResult = mwCtx.result;
          if (this.task.outputSchema) {
            handlerResult = await validateSchema(this.task.outputSchema, handlerResult);
          }
        } catch (err) {
          // Cancellation — don't self-feed, let poll loop handle re-fill
          if (controller.signal.aborted && controller.signal.reason === "cancelled") {
            await flushPendingWrites();
            await this.handleCancellation(raw.id, token, data, ctx);
            break;
          }

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

          this.onJobError?.({
            task: this.task.name,
            jobId: raw.id,
            error: err,
            attempt: raw.attempt,
            maxAttempts: retryConfig?.attempts ?? 1,
            willRetry: !!retryInfo,
          });

          await flushPendingWrites();

          // Self-fed fail path: atomically fail + dequeue next
          if (this.running && this.adapter.failAndDequeue) {
            const newToken = randomUUID();
            let reply: Taskora.AckAndDequeueResult | null = null;
            try {
              reply = await this.adapter.failAndDequeue(
                this.task.name,
                raw.id,
                token,
                errorMsg,
                retryInfo,
                newToken,
                LOCK_TTL,
                this.dequeueOptions,
              );
            } catch {
              // failAndDequeue failed (e.g. lock expired)
              break;
            }

            // Fire-and-forget workflow failure notification — don't block
            // the next job on cascade cancellation roundtrips. Lua already
            // handed us the workflow binding so this path issues zero
            // extra Redis ops for the common (non-workflow) case, and we
            // skip the call entirely when there's no workflow.
            if (!retryInfo && reply.ackedWorkflow) {
              this.failWorkflow(raw.id, errorMsg, reply.ackedWorkflow).catch(() => {});
            }

            if (reply.next && this.running) {
              // Swap activeJobs entry: old job → new job
              this.activeJobs.delete(currentRaw.id);
              currentRaw = reply.next;
              currentToken = newToken;
              currentController = new AbortController();
              this.activeJobs.set(currentRaw.id, {
                promise: tracked,
                token: currentToken,
                controller: currentController,
              });
              continue;
            }
            break;
          }

          // Shutdown or adapter without failAndDequeue → plain fail
          try {
            await this.adapter.fail(this.task.name, raw.id, token, errorMsg, retryInfo);
          } catch {
            // fail() itself failed (e.g. lock expired)
            break;
          }
          if (!retryInfo) {
            await this.failWorkflow(raw.id, errorMsg, null);
          }
          break;
        }

        // Cancelled while handler was running (handler didn't check signal)
        if (controller.signal.aborted && controller.signal.reason === "cancelled") {
          await flushPendingWrites();
          await this.handleCancellation(raw.id, token, data, ctx);
          break;
        }

        // Handler succeeded — drain any fire-and-forget progress/log writes
        // before the terminal ack so the event stream order is
        // (active → progress* → completed), not the other way around.
        await flushPendingWrites();
        const serializedResult = this.serializer.serialize(handlerResult);

        // Self-fed ack path: atomically ack + dequeue next
        if (this.running && this.adapter.ackAndDequeue) {
          const newToken = randomUUID();
          let reply: Taskora.AckAndDequeueResult | null = null;
          try {
            reply = await this.adapter.ackAndDequeue(
              this.task.name,
              raw.id,
              token,
              serializedResult,
              newToken,
              LOCK_TTL,
              this.dequeueOptions,
            );
          } catch {
            // ackAndDequeue failed (e.g. lock expired) — stall check will clean up
            break;
          }

          // Fire-and-forget workflow advance — skipped entirely for jobs
          // not bound to a workflow (the common case). The ack Lua
          // already returned the binding so we don't probe Redis again
          // here; for non-workflow jobs we avoid even the promise
          // allocation.
          if (reply.ackedWorkflow) {
            this.advanceWorkflow(raw.id, serializedResult, reply.ackedWorkflow).catch(() => {});
          }

          if (reply.next && this.running) {
            // Swap activeJobs entry: old job → new job
            this.activeJobs.delete(currentRaw.id);
            currentRaw = reply.next;
            currentToken = newToken;
            currentController = new AbortController();
            this.activeJobs.set(currentRaw.id, {
              promise: tracked,
              token: currentToken,
              controller: currentController,
            });
            continue;
          }
          break;
        }

        // Shutdown or adapter without ackAndDequeue → plain ack
        try {
          await this.adapter.ack(this.task.name, raw.id, token, serializedResult);
        } catch {
          break;
        }
        await this.advanceWorkflow(raw.id, serializedResult, null);
        break;
      }
    })();

    tracked = promise.finally(() => {
      this.activeJobs.delete(currentRaw.id);
      if (this.slotResolve) {
        this.slotResolve();
        this.slotResolve = null;
      }
    });

    this.activeJobs.set(initialRaw.id, {
      promise: tracked,
      token: initialToken,
      controller: currentController,
    });
  }

  private async runStalledCheck(): Promise<void> {
    try {
      await this.adapter.stalledCheck(this.task.name, this.maxStalledCount);
    } catch {
      // Stall check failed — will retry on next interval
    }

    // Retention trim — piggyback on stall check interval
    const now = Date.now();
    try {
      await this.adapter.trimCompleted(
        this.task.name,
        now - this.retention.completed.maxAgeMs,
        this.retention.completed.maxItems,
      );
    } catch {
      // Trim failed — will retry on next interval
    }
    try {
      await this.adapter.trimDLQ(
        this.task.name,
        now - this.retention.failed.maxAgeMs,
        this.retention.failed.maxItems,
      );
    } catch {
      // Trim failed — will retry on next interval
    }
  }

  private async handleCancellation(
    jobId: string,
    token: string,
    data: unknown,
    ctx?: Taskora.Context,
  ): Promise<void> {
    if (this.onCancel && ctx) {
      try {
        await this.onCancel(data, ctx);
      } catch {
        // onCancel hook failed — continue with finalization
      }
    }
    try {
      await this.adapter.finishCancel(this.task.name, jobId, token);
    } catch {
      // finishCancel failed — stall check will handle it
    }
  }

  /**
   * Advance a workflow after a node completed. Called with the workflow
   * binding already known (from the ack Lua reply when available, or a
   * fresh `getWorkflowMeta` on the shutdown fallback). The `meta`
   * parameter eliminates the `getWorkflowMeta` HMGET roundtrip on the
   * self-feeding hot path — that lookup was firing for every completed
   * job even when the task had no workflow nodes in flight.
   */
  private async advanceWorkflow(
    jobId: string,
    result: string,
    meta: { workflowId: string; nodeIndex: number } | null,
  ): Promise<void> {
    try {
      const resolved = meta ?? (await this.adapter.getWorkflowMeta(this.task.name, jobId));
      if (!resolved) return;

      const { toDispatch } = await this.adapter.advanceWorkflow(
        resolved.workflowId,
        resolved.nodeIndex,
        result,
      );

      for (const node of toDispatch) {
        await this.adapter.enqueue(node.taskName, node.jobId, node.data, {
          _v: node._v,
          _wf: resolved.workflowId,
          _wfNode: node.nodeIndex,
        });
      }
    } catch {
      // Workflow advance failed — individual jobs still completed
    }
  }

  private async failWorkflow(
    jobId: string,
    error: string,
    meta: { workflowId: string; nodeIndex: number } | null,
  ): Promise<void> {
    try {
      const resolved = meta ?? (await this.adapter.getWorkflowMeta(this.task.name, jobId));
      if (!resolved) return;

      const { activeJobIds } = await this.adapter.failWorkflow(
        resolved.workflowId,
        resolved.nodeIndex,
        error,
      );

      // Cascade cancel active jobs
      for (const { task, jobId: jid } of activeJobIds) {
        try {
          await this.adapter.cancel(task, jid, "workflow failed");
        } catch {
          // Job may have already finished
        }
      }
    } catch {
      // Workflow fail notification failed
    }
  }

  private async extendAllLocks(): Promise<void> {
    for (const [jobId, { token, controller }] of this.activeJobs) {
      try {
        const status = await this.adapter.extendLock(this.task.name, jobId, token, LOCK_TTL);
        if (status === "cancelled") {
          controller.abort("cancelled");
        }
      } catch {
        // Extension failed — lock may have expired
      }
    }
  }
}
