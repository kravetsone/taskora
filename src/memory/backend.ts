import type { Taskora } from "../types.js";

// ── Internal data structures ──────────────────────────────────────────

interface ZEntry {
  member: string;
  score: number;
}

interface Job {
  fields: Record<string, string>;
  data: string | null;
  result: string | null;
  lock: { token: string; expiresAt: number } | null;
  logs: string[];
}

interface TaskQueue {
  wait: string[];
  active: string[];
  delayed: ZEntry[];
  completed: ZEntry[];
  failed: ZEntry[];
  expired: ZEntry[];
  cancelled: ZEntry[];
  stalled: Set<string>;
}

interface CollectBuffer {
  items: string[];
  sentinelId: string | null;
  firstPushAt: number;
  maxWaitDeadline: number;
}

// ── Sorted set helpers ────────────────────────────────────────────────

function zAdd(set: ZEntry[], member: string, score: number, lt?: boolean): void {
  const idx = set.findIndex((e) => e.member === member);
  if (idx >= 0) {
    if (lt && score >= set[idx].score) return;
    set.splice(idx, 1);
  }
  let lo = 0;
  let hi = set.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (set[mid].score <= score) lo = mid + 1;
    else hi = mid;
  }
  set.splice(lo, 0, { member, score });
}

function zRem(set: ZEntry[], member: string): boolean {
  const idx = set.findIndex((e) => e.member === member);
  if (idx >= 0) {
    set.splice(idx, 1);
    return true;
  }
  return false;
}

function zScore(set: ZEntry[], member: string): number | null {
  const entry = set.find((e) => e.member === member);
  return entry ? entry.score : null;
}

function zRangeByScore(set: ZEntry[], min: number, max: number): string[] {
  return set.filter((e) => e.score >= min && e.score <= max).map((e) => e.member);
}

// ══════════════════════════════════════════════════════════════════════
// MemoryBackend — in-memory Taskora.Adapter implementation
// ══════════════════════════════════════════════════════════════════════

export class MemoryBackend implements Taskora.Adapter {
  // ── Per-task queues ──
  private taskQueues = new Map<string, TaskQueue>();
  private jobStore = new Map<string, Job>();
  private jobTask = new Map<string, string>();

  // ── Flow control ──
  private debounceKeys = new Map<string, string>();
  private throttleWindows = new Map<string, number[]>();
  private dedupKeys = new Map<string, string>();
  private collectBuffers = new Map<string, CollectBuffer>();
  private concurrencyCounters = new Map<string, number>();

  // ── Scheduling ──
  private scheduleConfigs = new Map<string, string>();
  private scheduleNextRuns: ZEntry[] = [];
  private schedulerLock: { token: string; expiresAt: number } | null = null;

  // ── Events ──
  private streamHandlers: Array<(event: Taskora.StreamEvent) => void> = [];
  private cancelHandlers = new Map<string, Set<(jobId: string) => void>>();
  private jobWaiters = new Map<
    string,
    Array<{
      resolve: (result: Taskora.AwaitJobResult) => void;
      timer?: ReturnType<typeof setTimeout>;
    }>
  >();

  /** @internal */
  _clock: () => number;

  constructor(options?: { clock?: () => number }) {
    this._clock = options?.clock ?? (() => Date.now());
  }

  private now(): number {
    return this._clock();
  }

  // ── Queue/job accessors ──

  private q(task: string): TaskQueue {
    let tq = this.taskQueues.get(task);
    if (!tq) {
      tq = {
        wait: [],
        active: [],
        delayed: [],
        completed: [],
        failed: [],
        expired: [],
        cancelled: [],
        stalled: new Set(),
      };
      this.taskQueues.set(task, tq);
    }
    return tq;
  }

  private j(id: string): Job {
    let job = this.jobStore.get(id);
    if (!job) {
      job = { fields: {}, data: null, result: null, lock: null, logs: [] };
      this.jobStore.set(id, job);
    }
    return job;
  }

  // ── Event helper ──

  private emit(task: string, event: string, jobId: string, fields: Record<string, string>): void {
    const ev: Taskora.StreamEvent = { task, event, jobId, fields };
    for (const handler of this.streamHandlers) {
      try {
        handler(ev);
      } catch {}
    }

    if (event === "completed" || event === "failed" || event === "cancelled") {
      const waiters = this.jobWaiters.get(jobId);
      if (waiters) {
        const job = this.jobStore.get(jobId);
        let result: Taskora.AwaitJobResult;
        if (event === "completed") {
          result = { state: "completed", result: job?.result ?? undefined };
        } else if (event === "cancelled") {
          result = { state: "cancelled", error: fields.reason || job?.fields.cancelReason };
        } else {
          result = { state: "failed", error: fields.error || job?.fields.error };
        }
        for (const w of waiters) {
          if (w.timer) clearTimeout(w.timer);
          w.resolve(result);
        }
        this.jobWaiters.delete(jobId);
      }
    }
  }

  // ── Concurrency / dedup helpers ──

  private incrConcurrency(task: string, jobId: string): boolean {
    const job = this.jobStore.get(jobId);
    if (!job) return true;
    const key = job.fields.concurrencyKey;
    const limit = Number(job.fields.concurrencyLimit || 0);
    if (!key || limit <= 0) return true;

    const fullKey = `${task}:conc:${key}`;
    const current = this.concurrencyCounters.get(fullKey) ?? 0;
    if (current >= limit) return false;
    this.concurrencyCounters.set(fullKey, current + 1);
    return true;
  }

  private decrConcurrency(task: string, jobId: string): void {
    const job = this.jobStore.get(jobId);
    if (!job) return;
    const key = job.fields.concurrencyKey;
    if (!key) return;
    const fullKey = `${task}:conc:${key}`;
    const current = this.concurrencyCounters.get(fullKey) ?? 0;
    if (current > 0) this.concurrencyCounters.set(fullKey, current - 1);
  }

  private cleanDedupKey(jobId: string): void {
    for (const [key, id] of this.dedupKeys) {
      if (id === jobId) {
        this.dedupKeys.delete(key);
        return;
      }
    }
  }

  // ── Promote delayed → waiting ──

  /** @internal */
  promoteDelayed(task: string): void {
    const tq = this.q(task);
    const now = this.now();
    while (tq.delayed.length > 0 && tq.delayed[0].score <= now) {
      const entry = tq.delayed.shift();
      if (!entry) break;
      const job = this.jobStore.get(entry.member);
      if (!job) continue;
      job.fields.state = "waiting";
      tq.wait.push(entry.member);
    }
  }

  /** @internal */
  promoteAll(): void {
    for (const task of this.taskQueues.keys()) {
      this.promoteDelayed(task);
    }
  }

  /** @internal */
  getTaskNames(): string[] {
    return [...this.taskQueues.keys()];
  }

  /** @internal — earliest delayed job score across all tasks */
  getEarliestDelayedScore(): number | null {
    let earliest: number | null = null;
    for (const tq of this.taskQueues.values()) {
      if (tq.delayed.length > 0) {
        const score = tq.delayed[0].score;
        if (earliest === null || score < earliest) earliest = score;
      }
    }
    return earliest;
  }

  /** @internal */
  forceFlushCollect(task: string, key?: string): void {
    const prefix = `${task}:`;
    const toDelete: string[] = [];

    for (const [bufferKey, buffer] of this.collectBuffers) {
      if (!bufferKey.startsWith(prefix)) continue;
      if (key && bufferKey !== `${task}:${key}`) continue;
      if (buffer.items.length === 0) continue;

      const tq = this.q(task);
      const now = this.now();

      if (buffer.sentinelId) {
        zRem(tq.delayed, buffer.sentinelId);
        const job = this.jobStore.get(buffer.sentinelId);
        if (job) {
          const items = buffer.items.splice(0);
          job.data = `[${items.join(",")}]`;
          job.fields.state = "waiting";
          job.fields.collectKey = "";
          job.fields.collectTask = "";
          tq.wait.push(buffer.sentinelId);
          this.emit(task, "waiting", buffer.sentinelId, {});
        }
        buffer.sentinelId = null;
      }
      toDelete.push(bufferKey);
    }

    for (const k of toDelete) this.collectBuffers.delete(k);
  }

  /** @internal */
  clear(): void {
    this.taskQueues.clear();
    this.jobStore.clear();
    this.jobTask.clear();
    this.debounceKeys.clear();
    this.throttleWindows.clear();
    this.dedupKeys.clear();
    this.collectBuffers.clear();
    this.concurrencyCounters.clear();
    this.scheduleConfigs.clear();
    this.scheduleNextRuns = [];
    this.schedulerLock = null;
    this.streamHandlers = [];
    this.cancelHandlers.clear();
    for (const waiters of this.jobWaiters.values()) {
      for (const w of waiters) {
        if (w.timer) clearTimeout(w.timer);
      }
    }
    this.jobWaiters.clear();
  }

  /** @internal */
  getAllJobs(): Array<{ id: string; task: string; state: string; fields: Record<string, string> }> {
    const result: Array<{
      id: string;
      task: string;
      state: string;
      fields: Record<string, string>;
    }> = [];
    for (const [id, job] of this.jobStore) {
      result.push({
        id,
        task: this.jobTask.get(id) ?? "unknown",
        state: job.fields.state ?? "unknown",
        fields: { ...job.fields },
      });
    }
    return result;
  }

  // ══════════════════════════════════════════════════════════════════════
  // Adapter interface
  // ══════════════════════════════════════════════════════════════════════

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  // ── Enqueue variants ──

  async enqueue(
    task: string,
    jobId: string,
    data: string,
    options: {
      _v: number;
      maxAttempts?: number;
      expireAt?: number;
      concurrencyKey?: string;
      concurrencyLimit?: number;
    } & Taskora.DispatchOptions,
  ): Promise<void> {
    const tq = this.q(task);
    const now = this.now();

    const job = this.j(jobId);
    job.data = data;
    job.fields = {
      ts: String(now),
      _v: String(options._v),
      attempt: "0",
      maxAttempts: String(options.maxAttempts ?? 1),
      priority: String(options.priority ?? 0),
      expireAt: String(options.expireAt ?? 0),
      concurrencyKey: options.concurrencyKey ?? "",
      concurrencyLimit: String(options.concurrencyLimit ?? 0),
      state: "waiting",
    };
    this.jobTask.set(jobId, task);

    if (options.delay && options.delay > 0) {
      job.fields.state = "delayed";
      job.fields.delay = String(options.delay);
      zAdd(tq.delayed, jobId, now + options.delay);
    } else {
      tq.wait.push(jobId);
    }
    this.emit(task, "waiting", jobId, {});
  }

  async debounceEnqueue(
    task: string,
    jobId: string,
    data: string,
    options: {
      _v: number;
      maxAttempts?: number;
      priority?: number;
      expireAt?: number;
      concurrencyKey?: string;
      concurrencyLimit?: number;
    },
    debounceKey: string,
    delayMs: number,
  ): Promise<void> {
    const tq = this.q(task);

    const prevId = this.debounceKeys.get(debounceKey);
    if (prevId) {
      zRem(tq.delayed, prevId);
      this.jobStore.delete(prevId);
      this.jobTask.delete(prevId);
    }

    const now = this.now();
    const job = this.j(jobId);
    job.data = data;
    job.fields = {
      ts: String(now),
      _v: String(options._v),
      state: "delayed",
      attempt: "0",
      maxAttempts: String(options.maxAttempts ?? 1),
      priority: String(options.priority ?? 0),
      expireAt: String(options.expireAt ?? 0),
      concurrencyKey: options.concurrencyKey ?? "",
      concurrencyLimit: String(options.concurrencyLimit ?? 0),
    };
    this.jobTask.set(jobId, task);
    this.debounceKeys.set(debounceKey, jobId);

    zAdd(tq.delayed, jobId, now + delayMs);
    this.emit(task, "waiting", jobId, {});
  }

  async throttleEnqueue(
    task: string,
    jobId: string,
    data: string,
    options: {
      _v: number;
      maxAttempts?: number;
      delay?: number;
      priority?: number;
      expireAt?: number;
      concurrencyKey?: string;
      concurrencyLimit?: number;
    },
    throttleKey: string,
    max: number,
    windowMs: number,
  ): Promise<boolean> {
    const now = this.now();

    let timestamps = this.throttleWindows.get(throttleKey);
    if (!timestamps) {
      timestamps = [];
      this.throttleWindows.set(throttleKey, timestamps);
    }

    const cutoff = now - windowMs;
    const filtered = timestamps.filter((t) => t > cutoff);
    this.throttleWindows.set(throttleKey, filtered);

    if (filtered.length >= max) return false;

    filtered.push(now);
    await this.enqueue(task, jobId, data, { ...options, _v: options._v });
    return true;
  }

  async deduplicateEnqueue(
    task: string,
    jobId: string,
    data: string,
    options: {
      _v: number;
      maxAttempts?: number;
      delay?: number;
      priority?: number;
      expireAt?: number;
      concurrencyKey?: string;
      concurrencyLimit?: number;
    },
    dedupKey: string,
    states: string[],
  ): Promise<{ created: true } | { created: false; existingId: string }> {
    const existingId = this.dedupKeys.get(dedupKey);
    if (existingId) {
      const job = this.jobStore.get(existingId);
      if (job) {
        const s = job.fields.state;
        const mapped = s === "retrying" ? "delayed" : s;
        if (mapped && states.includes(mapped)) {
          return { created: false, existingId };
        }
      }
    }

    await this.enqueue(task, jobId, data, { ...options, _v: options._v });
    this.dedupKeys.set(dedupKey, jobId);
    return { created: true };
  }

  async collectPush(
    task: string,
    jobId: string,
    item: string,
    options: {
      _v: number;
      maxAttempts?: number;
      collectKey: string;
      delayMs: number;
      maxSize: number;
      maxWaitMs: number;
    },
  ): Promise<{ flushed: boolean; count: number }> {
    const tq = this.q(task);
    const now = this.now();
    const bufferKey = `${task}:${options.collectKey}`;

    let buffer = this.collectBuffers.get(bufferKey);
    if (!buffer) {
      buffer = {
        items: [],
        sentinelId: null,
        firstPushAt: now,
        maxWaitDeadline: options.maxWaitMs > 0 ? now + options.maxWaitMs : 0,
      };
      this.collectBuffers.set(bufferKey, buffer);
    }
    buffer.items.push(item);

    // maxSize flush — immediate
    if (options.maxSize > 0 && buffer.items.length >= options.maxSize) {
      const items = buffer.items.splice(0);
      const job = this.j(jobId);
      job.data = `[${items.join(",")}]`;
      job.fields = {
        ts: String(now),
        _v: String(options._v),
        state: "waiting",
        attempt: "0",
        maxAttempts: String(options.maxAttempts ?? 1),
      };
      this.jobTask.set(jobId, task);
      tq.wait.push(jobId);
      this.emit(task, "waiting", jobId, {});

      if (buffer.sentinelId) {
        zRem(tq.delayed, buffer.sentinelId);
        this.jobStore.delete(buffer.sentinelId);
        this.jobTask.delete(buffer.sentinelId);
      }
      this.collectBuffers.delete(bufferKey);
      return { flushed: true, count: items.length };
    }

    // Debounce: replace sentinel
    if (buffer.sentinelId) {
      zRem(tq.delayed, buffer.sentinelId);
      this.jobStore.delete(buffer.sentinelId);
      this.jobTask.delete(buffer.sentinelId);
    }

    const sentinel = this.j(jobId);
    sentinel.data = null;
    sentinel.fields = {
      ts: String(now),
      _v: String(options._v),
      state: "delayed",
      attempt: "0",
      maxAttempts: String(options.maxAttempts ?? 1),
      collectKey: options.collectKey,
      collectTask: task,
    };
    this.jobTask.set(jobId, task);

    let flushAt = now + options.delayMs;
    if (buffer.maxWaitDeadline > 0 && flushAt > buffer.maxWaitDeadline) {
      flushAt = buffer.maxWaitDeadline;
    }
    zAdd(tq.delayed, jobId, flushAt);
    buffer.sentinelId = jobId;

    return { flushed: false, count: buffer.items.length };
  }

  // ── Dequeue ──

  async dequeue(
    task: string,
    lockTtl: number,
    token: string,
    options?: Taskora.DequeueOptions,
  ): Promise<Taskora.DequeueResult | null> {
    const tq = this.q(task);
    const now = this.now();

    this.promoteDelayed(task);

    if (options?.singleton && tq.active.length > 0) return null;

    const jobId = tq.wait.shift();
    if (!jobId) return null;

    const job = this.jobStore.get(jobId);
    if (!job) return null;

    // TTL expiry check
    const expireAt = Number(job.fields.expireAt || 0);
    if (expireAt > 0 && now >= expireAt) {
      job.fields.state = "expired";
      job.fields.finishedOn = String(now);
      zAdd(tq.expired, jobId, now);
      if ((options?.onExpire ?? "fail") === "fail") {
        this.emit(task, "failed", jobId, {
          error: "Job expired",
          attempt: job.fields.attempt || "1",
        });
      }
      return this.dequeue(task, lockTtl, token, options);
    }

    // Concurrency key check
    if (!this.incrConcurrency(task, jobId)) {
      tq.wait.unshift(jobId);
      return null;
    }

    // Activate
    tq.active.push(jobId);
    job.fields.state = "active";
    job.fields.processedOn = String(now);
    const attempt = Number(job.fields.attempt || 0) + 1;
    job.fields.attempt = String(attempt);
    job.lock = { token, expiresAt: now + lockTtl };

    // Drain collect buffer
    const collectKey = job.fields.collectKey;
    if (collectKey) {
      const bufferKey = `${task}:${collectKey}`;
      const buffer = this.collectBuffers.get(bufferKey);
      if (buffer && buffer.items.length > 0) {
        job.data = `[${buffer.items.join(",")}]`;
        buffer.items = [];
        this.collectBuffers.delete(bufferKey);
      } else if (!job.data) {
        job.data = "[]";
      }
      job.fields.collectKey = "";
      job.fields.collectTask = "";
    }

    this.emit(task, "active", jobId, { attempt: String(attempt) });

    return {
      id: jobId,
      data: job.data ?? "",
      _v: Number(job.fields._v || 1),
      attempt,
      timestamp: Number(job.fields.ts || now),
    };
  }

  async blockingDequeue(
    task: string,
    lockTtl: number,
    token: string,
    _timeoutMs: number,
    options?: Taskora.DequeueOptions,
  ): Promise<Taskora.DequeueResult | null> {
    return this.dequeue(task, lockTtl, token, options);
  }

  // ── Ack / Fail / Nack ──

  async ack(task: string, jobId: string, token: string, result: string): Promise<void> {
    const tq = this.q(task);
    const job = this.jobStore.get(jobId);
    if (!job || !job.lock || job.lock.token !== token) return;

    const now = this.now();
    const idx = tq.active.indexOf(jobId);
    if (idx >= 0) tq.active.splice(idx, 1);

    job.result = result;
    job.fields.state = "completed";
    job.fields.finishedOn = String(now);
    job.lock = null;

    zAdd(tq.completed, jobId, now);
    this.decrConcurrency(task, jobId);
    this.cleanDedupKey(jobId);

    const duration = job.fields.processedOn ? String(now - Number(job.fields.processedOn)) : "0";
    this.emit(task, "completed", jobId, {
      result,
      duration,
      attempt: job.fields.attempt || "1",
    });
  }

  async fail(
    task: string,
    jobId: string,
    token: string,
    error: string,
    retry?: { delay: number },
  ): Promise<void> {
    const tq = this.q(task);
    const job = this.jobStore.get(jobId);
    if (!job || !job.lock || job.lock.token !== token) return;

    const now = this.now();
    const idx = tq.active.indexOf(jobId);
    if (idx >= 0) tq.active.splice(idx, 1);
    job.lock = null;

    if (retry) {
      job.fields.state = "retrying";
      job.fields.error = error;
      const retryAt = now + retry.delay;
      zAdd(tq.delayed, jobId, retryAt);
      this.emit(task, "retrying", jobId, {
        error,
        attempt: job.fields.attempt || "1",
        nextAttemptAt: String(retryAt),
      });
    } else {
      job.fields.state = "failed";
      job.fields.error = error;
      job.fields.finishedOn = String(now);
      zAdd(tq.failed, jobId, now);
      this.decrConcurrency(task, jobId);
      this.cleanDedupKey(jobId);
      this.emit(task, "failed", jobId, { error, attempt: job.fields.attempt || "1" });
    }
  }

  async nack(task: string, jobId: string, token: string): Promise<void> {
    const tq = this.q(task);
    const job = this.jobStore.get(jobId);
    if (!job || !job.lock || job.lock.token !== token) return;

    const idx = tq.active.indexOf(jobId);
    if (idx >= 0) tq.active.splice(idx, 1);

    job.fields.state = "waiting";
    job.lock = null;
    tq.wait.push(jobId);
    this.emit(task, "waiting", jobId, {});
  }

  // ── Lock ──

  async extendLock(
    task: string,
    jobId: string,
    token: string,
    ttl: number,
  ): Promise<"extended" | "lost" | "cancelled"> {
    const job = this.jobStore.get(jobId);
    if (!job) return "lost";
    if (job.fields.cancelledAt) return "cancelled";
    if (!job.lock || job.lock.token !== token) return "lost";

    job.lock.expiresAt = this.now() + ttl;
    this.q(task).stalled.delete(jobId);
    return "extended";
  }

  // ── Cancel ──

  async cancel(
    task: string,
    jobId: string,
    reason?: string,
  ): Promise<"cancelled" | "flagged" | "not_cancellable"> {
    const tq = this.q(task);
    const job = this.jobStore.get(jobId);
    if (!job) return "not_cancellable";

    const now = this.now();
    const state = job.fields.state;

    if (state === "waiting" || state === "delayed" || state === "retrying") {
      if (state === "waiting") {
        const idx = tq.wait.indexOf(jobId);
        if (idx >= 0) tq.wait.splice(idx, 1);
      } else {
        zRem(tq.delayed, jobId);
      }
      job.fields.state = "cancelled";
      job.fields.finishedOn = String(now);
      if (reason) job.fields.cancelReason = reason;
      zAdd(tq.cancelled, jobId, now);
      this.decrConcurrency(task, jobId);
      this.cleanDedupKey(jobId);
      this.emit(task, "cancelled", jobId, { reason: reason ?? "" });
      return "cancelled";
    }

    if (state === "active") {
      job.fields.cancelledAt = String(now);
      if (reason) job.fields.cancelReason = reason;
      const handlers = this.cancelHandlers.get(task);
      if (handlers) {
        for (const h of handlers) {
          try {
            h(jobId);
          } catch {}
        }
      }
      return "flagged";
    }

    return "not_cancellable";
  }

  async finishCancel(task: string, jobId: string, token: string): Promise<void> {
    const tq = this.q(task);
    const job = this.jobStore.get(jobId);
    if (!job || !job.lock || job.lock.token !== token) return;

    const now = this.now();
    const idx = tq.active.indexOf(jobId);
    if (idx >= 0) tq.active.splice(idx, 1);

    job.fields.state = "cancelled";
    job.fields.finishedOn = String(now);
    job.lock = null;
    zAdd(tq.cancelled, jobId, now);
    this.decrConcurrency(task, jobId);
    this.cleanDedupKey(jobId);
    this.emit(task, "cancelled", jobId, { reason: job.fields.cancelReason ?? "" });
  }

  async onCancel(task: string, handler: (jobId: string) => void): Promise<() => void> {
    let handlers = this.cancelHandlers.get(task);
    if (!handlers) {
      handlers = new Set();
      this.cancelHandlers.set(task, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
    };
  }

  // ── Stalled check ──

  async stalledCheck(
    task: string,
    maxStalledCount: number,
  ): Promise<{ recovered: string[]; failed: string[] }> {
    const tq = this.q(task);
    const now = this.now();
    const recovered: string[] = [];
    const failed: string[] = [];

    for (const jobId of tq.stalled) {
      const job = this.jobStore.get(jobId);
      if (!job || !tq.active.includes(jobId)) continue;
      if (job.lock && job.lock.expiresAt > now) continue;

      if (job.fields.cancelledAt) {
        const ai = tq.active.indexOf(jobId);
        if (ai >= 0) tq.active.splice(ai, 1);
        job.fields.state = "cancelled";
        job.fields.finishedOn = String(now);
        job.lock = null;
        zAdd(tq.cancelled, jobId, now);
        this.emit(task, "cancelled", jobId, { reason: job.fields.cancelReason ?? "" });
        continue;
      }

      const count = Number(job.fields.stalledCount || 0) + 1;
      job.fields.stalledCount = String(count);

      const ai = tq.active.indexOf(jobId);
      if (ai >= 0) tq.active.splice(ai, 1);
      job.lock = null;

      if (count > maxStalledCount) {
        job.fields.state = "failed";
        job.fields.error = `Stalled ${count} times (max: ${maxStalledCount})`;
        job.fields.finishedOn = String(now);
        zAdd(tq.failed, jobId, now);
        this.decrConcurrency(task, jobId);
        this.emit(task, "stalled", jobId, { count: String(count), action: "failed" });
        this.emit(task, "failed", jobId, {
          error: job.fields.error,
          attempt: job.fields.attempt || "1",
        });
        failed.push(jobId);
      } else {
        job.fields.state = "waiting";
        tq.wait.push(jobId);
        this.emit(task, "stalled", jobId, { count: String(count), action: "recovered" });
        recovered.push(jobId);
      }
    }

    tq.stalled.clear();
    for (const jobId of tq.active) {
      tq.stalled.add(jobId);
    }

    return { recovered, failed };
  }

  // ── Progress / Logs ──

  async setProgress(task: string, jobId: string, value: string): Promise<void> {
    const job = this.jobStore.get(jobId);
    if (job) {
      job.fields.progress = value;
      this.emit(task, "progress", jobId, { value });
    }
  }

  async addLog(_task: string, jobId: string, entry: string): Promise<void> {
    const job = this.jobStore.get(jobId);
    if (job) job.logs.push(entry);
  }

  // ── State queries ──

  async getState(_task: string, jobId: string): Promise<Taskora.JobState | null> {
    const job = this.jobStore.get(jobId);
    return (job?.fields.state as Taskora.JobState) ?? null;
  }

  async getResult(_task: string, jobId: string): Promise<string | null> {
    return this.jobStore.get(jobId)?.result ?? null;
  }

  async getError(_task: string, jobId: string): Promise<string | null> {
    return this.jobStore.get(jobId)?.fields.error ?? null;
  }

  async getProgress(_task: string, jobId: string): Promise<string | null> {
    return this.jobStore.get(jobId)?.fields.progress ?? null;
  }

  async getLogs(_task: string, jobId: string): Promise<string[]> {
    return this.jobStore.get(jobId)?.logs ?? [];
  }

  // ── Events ──

  async subscribe(
    _tasks: string[],
    handler: (event: Taskora.StreamEvent) => void,
  ): Promise<() => Promise<void>> {
    this.streamHandlers.push(handler);
    return async () => {
      const idx = this.streamHandlers.indexOf(handler);
      if (idx >= 0) this.streamHandlers.splice(idx, 1);
    };
  }

  async awaitJob(
    _task: string,
    jobId: string,
    timeoutMs?: number,
  ): Promise<Taskora.AwaitJobResult | null> {
    const job = this.jobStore.get(jobId);
    if (job) {
      const s = job.fields.state;
      if (s === "completed") return { state: "completed", result: job.result ?? undefined };
      if (s === "failed") return { state: "failed", error: job.fields.error };
      if (s === "cancelled") return { state: "cancelled", error: job.fields.cancelReason };
    }

    return new Promise<Taskora.AwaitJobResult | null>((resolve) => {
      let waiters = this.jobWaiters.get(jobId);
      if (!waiters) {
        waiters = [];
        this.jobWaiters.set(jobId, waiters);
      }
      const entry: (typeof waiters)[number] = { resolve };
      if (timeoutMs != null && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          const arr = this.jobWaiters.get(jobId);
          if (arr) {
            const i = arr.indexOf(entry);
            if (i >= 0) arr.splice(i, 1);
            if (arr.length === 0) this.jobWaiters.delete(jobId);
          }
          resolve(null);
        }, timeoutMs);
      }
      waiters.push(entry);
    });
  }

  // ── Inspector ──

  async listJobDetails(
    task: string,
    state: "waiting" | "active" | "delayed" | "completed" | "failed" | "expired" | "cancelled",
    offset: number,
    limit: number,
  ): Promise<Array<{ id: string; details: Taskora.RawJobDetails }>> {
    const tq = this.q(task);
    let ids: string[];

    switch (state) {
      case "waiting":
        ids = tq.wait.slice(offset, offset + limit);
        break;
      case "active":
        ids = tq.active.slice(offset, offset + limit);
        break;
      case "delayed":
        ids = tq.delayed.slice(offset, offset + limit).map((e) => e.member);
        break;
      case "completed":
        ids = [...tq.completed]
          .reverse()
          .slice(offset, offset + limit)
          .map((e) => e.member);
        break;
      case "failed":
        ids = [...tq.failed]
          .reverse()
          .slice(offset, offset + limit)
          .map((e) => e.member);
        break;
      case "expired":
        ids = [...tq.expired]
          .reverse()
          .slice(offset, offset + limit)
          .map((e) => e.member);
        break;
      case "cancelled":
        ids = [...tq.cancelled]
          .reverse()
          .slice(offset, offset + limit)
          .map((e) => e.member);
        break;
      default:
        ids = [];
    }

    return ids.map((id) => {
      const job = this.jobStore.get(id);
      return {
        id,
        details: {
          fields: job ? { ...job.fields } : {},
          data: job?.data ?? null,
          result: job?.result ?? null,
          logs: job ? [...job.logs] : [],
        },
      };
    });
  }

  async getJobDetails(_task: string, jobId: string): Promise<Taskora.RawJobDetails | null> {
    const job = this.jobStore.get(jobId);
    if (!job || Object.keys(job.fields).length === 0) return null;
    return {
      fields: { ...job.fields },
      data: job.data,
      result: job.result,
      logs: [...job.logs],
    };
  }

  async getQueueStats(task: string): Promise<Taskora.QueueStats> {
    const tq = this.q(task);
    return {
      waiting: tq.wait.length,
      active: tq.active.length,
      delayed: tq.delayed.length,
      completed: tq.completed.length,
      failed: tq.failed.length,
      expired: tq.expired.length,
      cancelled: tq.cancelled.length,
    };
  }

  // ── DLQ ──

  async retryFromDLQ(task: string, jobId: string): Promise<boolean> {
    const tq = this.q(task);
    if (!zRem(tq.failed, jobId)) return false;

    const job = this.jobStore.get(jobId);
    if (job) {
      job.fields.state = "waiting";
      job.fields.attempt = "0";
      job.fields.error = "";
      job.fields.finishedOn = "";
    }
    tq.wait.push(jobId);
    this.emit(task, "waiting", jobId, {});
    return true;
  }

  async retryAllFromDLQ(task: string, limit: number): Promise<number> {
    const tq = this.q(task);
    const ids = tq.failed.slice(0, limit).map((e) => e.member);
    let count = 0;
    for (const id of ids) {
      if (await this.retryFromDLQ(task, id)) count++;
    }
    return count;
  }

  async trimDLQ(task: string, before: number, maxItems: number): Promise<number> {
    return this.trimSortedSet(this.q(task).failed, before, maxItems);
  }

  async trimCompleted(task: string, before: number, maxItems: number): Promise<number> {
    return this.trimSortedSet(this.q(task).completed, before, maxItems);
  }

  private trimSortedSet(set: ZEntry[], before: number, maxItems: number): number {
    let trimmed = 0;

    // Phase 1: age-based trim
    if (before > 0) {
      const toRemove = set.filter((e) => e.score < before);
      for (const entry of toRemove) {
        zRem(set, entry.member);
        this.jobStore.delete(entry.member);
        this.jobTask.delete(entry.member);
      }
      trimmed += toRemove.length;
    }

    // Phase 2: count-based trim (evict oldest)
    if (maxItems > 0 && set.length > maxItems) {
      const excess = set.length - maxItems;
      const oldest = set.slice(0, excess);
      for (const entry of oldest) {
        zRem(set, entry.member);
        this.jobStore.delete(entry.member);
        this.jobTask.delete(entry.member);
      }
      trimmed += oldest.length;
    }

    return trimmed;
  }

  // ── Version distribution ──

  async getVersionDistribution(task: string): Promise<{
    waiting: Record<number, number>;
    active: Record<number, number>;
    delayed: Record<number, number>;
  }> {
    const tq = this.q(task);
    const dist = {
      waiting: {} as Record<number, number>,
      active: {} as Record<number, number>,
      delayed: {} as Record<number, number>,
    };

    const count = (bucket: Record<number, number>, ids: string[]) => {
      for (const id of ids) {
        const v = Number(this.jobStore.get(id)?.fields._v || 1);
        bucket[v] = (bucket[v] || 0) + 1;
      }
    };

    count(dist.waiting, tq.wait);
    count(dist.active, tq.active);
    count(
      dist.delayed,
      tq.delayed.map((e) => e.member),
    );
    return dist;
  }

  // ── Scheduling ──

  async addSchedule(name: string, config: string, nextRun: number): Promise<void> {
    this.scheduleConfigs.set(name, config);
    zAdd(this.scheduleNextRuns, name, nextRun);
  }

  async removeSchedule(name: string): Promise<void> {
    this.scheduleConfigs.delete(name);
    zRem(this.scheduleNextRuns, name);
  }

  async getSchedule(
    name: string,
  ): Promise<{ config: string; nextRun: number | null; paused: boolean } | null> {
    const config = this.scheduleConfigs.get(name);
    if (!config) return null;
    const score = zScore(this.scheduleNextRuns, name);
    return { config, nextRun: score, paused: score === null };
  }

  async listSchedules(): Promise<Taskora.ScheduleRecord[]> {
    return [...this.scheduleConfigs].map(([name, config]) => ({
      name,
      config,
      nextRun: zScore(this.scheduleNextRuns, name),
    }));
  }

  async tickScheduler(now: number): Promise<Array<{ name: string; config: string }>> {
    const due = zRangeByScore(this.scheduleNextRuns, 0, now);
    const results: Array<{ name: string; config: string }> = [];
    for (const name of due) {
      zRem(this.scheduleNextRuns, name);
      const config = this.scheduleConfigs.get(name);
      if (config) results.push({ name, config });
    }
    return results;
  }

  async updateScheduleNextRun(name: string, config: string, nextRun: number): Promise<void> {
    this.scheduleConfigs.set(name, config);
    zAdd(this.scheduleNextRuns, name, nextRun);
  }

  async pauseSchedule(name: string): Promise<void> {
    zRem(this.scheduleNextRuns, name);
  }

  async resumeSchedule(name: string, nextRun: number): Promise<void> {
    zAdd(this.scheduleNextRuns, name, nextRun);
  }

  async acquireSchedulerLock(token: string, ttl: number): Promise<boolean> {
    const now = this.now();
    if (this.schedulerLock && this.schedulerLock.expiresAt > now) return false;
    this.schedulerLock = { token, expiresAt: now + ttl };
    return true;
  }

  async renewSchedulerLock(token: string, ttl: number): Promise<boolean> {
    if (!this.schedulerLock || this.schedulerLock.token !== token) return false;
    this.schedulerLock.expiresAt = this.now() + ttl;
    return true;
  }
}
