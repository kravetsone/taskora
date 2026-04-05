import type { RetryError } from "./errors.js";
import type { Duration as DurationType } from "./scheduler/duration.js";

export namespace Taskora {
  // ── Event payloads ──────────────────────────────────────────────────

  export interface CompletedEvent<TOutput> {
    id: string;
    result: TOutput;
    duration: number;
    attempt: number;
  }

  export interface FailedEvent {
    id: string;
    error: string;
    attempt: number;
    willRetry: boolean;
  }

  export interface RetryingEvent {
    id: string;
    attempt: number;
    nextAttempt: number;
    error: string;
  }

  export interface ProgressEvent {
    id: string;
    progress: number | Record<string, unknown>;
  }

  export interface ActiveEvent {
    id: string;
    attempt: number;
  }

  export interface StalledEvent {
    id: string;
    count: number;
    action: "recovered" | "failed";
  }

  export interface CancelledEvent {
    id: string;
    reason?: string;
  }

  export interface TaskEventMap<TOutput> {
    completed: CompletedEvent<TOutput>;
    failed: FailedEvent;
    retrying: RetryingEvent;
    progress: ProgressEvent;
    active: ActiveEvent;
    stalled: StalledEvent;
    cancelled: CancelledEvent;
  }

  export interface AppEventMap {
    "task:completed": CompletedEvent<unknown> & { task: string };
    "task:failed": FailedEvent & { task: string };
    "task:active": ActiveEvent & { task: string };
    "task:stalled": StalledEvent & { task: string };
    "task:cancelled": CancelledEvent & { task: string };
    "worker:ready": undefined;
    "worker:error": Error;
    "worker:closing": undefined;
  }

  export interface StreamEvent {
    task: string;
    event: string;
    jobId: string;
    fields: Record<string, string>;
  }

  // ── Core types ──────────────────────────────────────────────────────

  export type JobState =
    | "waiting"
    | "delayed"
    | "active"
    | "completed"
    | "failed"
    | "retrying"
    | "cancelled"
    | "expired";

  export type BackoffStrategy = "fixed" | "exponential" | "linear" | ((attempt: number) => number);

  export interface RetryConfig {
    attempts: number;
    backoff?: BackoffStrategy;
    delay?: number;
    maxDelay?: number;
    jitter?: boolean;
    retryOn?: Array<new (...args: any[]) => Error>;
    noRetryOn?: Array<new (...args: any[]) => Error>;
  }

  export interface StallConfig {
    interval?: number;
    maxCount?: number;
  }

  export interface DebounceConfig {
    key: string;
    delay: DurationType;
  }

  export interface ThrottleConfig {
    key: string;
    max: number;
    window: DurationType;
  }

  export interface DeduplicateConfig {
    key: string;
    while?: Array<"waiting" | "delayed" | "active">;
  }

  export interface TtlConfig {
    max: DurationType;
    onExpire?: "fail" | "discard";
  }

  export interface CollectConfig<TInput = unknown> {
    key: ((data: TInput) => string) | string;
    delay: DurationType;
    maxSize?: number;
    maxWait?: DurationType;
  }

  export interface DispatchOptions {
    delay?: number;
    priority?: number;
    ttl?: DurationType;
    concurrencyKey?: string;
    concurrencyLimit?: number;
    debounce?: DebounceConfig;
    throttle?: ThrottleConfig;
    deduplicate?: DeduplicateConfig;
    throwOnReject?: boolean;
  }

  export interface DequeueOptions {
    onExpire?: "fail" | "discard";
    singleton?: boolean;
  }

  /** @deprecated Use DispatchOptions instead */
  export type JobOptions = DispatchOptions;

  export interface RawJob {
    id: string;
    task: string;
    data: unknown;
    options: DispatchOptions;
    state: JobState;
    _v: number;
    attempt: number;
    timestamp: number;
  }

  export interface Serializer {
    serialize(value: unknown): string;
    deserialize(raw: string): unknown;
  }

  export interface DequeueResult {
    id: string;
    data: string;
    _v: number;
    attempt: number;
    timestamp: number;
  }

  export interface LogEntry {
    level: "info" | "warn" | "error";
    message: string;
    meta?: Record<string, unknown>;
    timestamp: number;
  }

  export interface ContextLog {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  }

  export interface Context {
    id: string;
    attempt: number;
    timestamp: number;
    signal: AbortSignal;
    heartbeat(): void;
    retry(options?: { delay?: number; reason?: string }): RetryError;
    progress(value: number | Record<string, unknown>): void;
    log: ContextLog;
  }

  export interface MiddlewareContext extends Context {
    task: { name: string };
    data: unknown;
    result: unknown;
  }

  export type Middleware = (
    ctx: MiddlewareContext,
    next: () => Promise<void>,
  ) => Promise<void> | void;

  export interface Adapter {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    enqueue(
      task: string,
      jobId: string,
      data: string,
      options: {
        _v: number;
        maxAttempts?: number;
        expireAt?: number;
        concurrencyKey?: string;
        concurrencyLimit?: number;
      } & DispatchOptions,
    ): Promise<void>;
    debounceEnqueue(
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
    ): Promise<void>;
    throttleEnqueue(
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
    ): Promise<boolean>;
    deduplicateEnqueue(
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
    ): Promise<{ created: true } | { created: false; existingId: string }>;
    collectPush(
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
    ): Promise<{ flushed: boolean; count: number }>;
    dequeue(
      task: string,
      lockTtl: number,
      token: string,
      options?: DequeueOptions,
    ): Promise<DequeueResult | null>;
    blockingDequeue(
      task: string,
      lockTtl: number,
      token: string,
      timeoutMs: number,
      options?: DequeueOptions,
    ): Promise<DequeueResult | null>;
    ack(task: string, jobId: string, token: string, result: string): Promise<void>;
    fail(
      task: string,
      jobId: string,
      token: string,
      error: string,
      retry?: { delay: number },
    ): Promise<void>;
    nack(task: string, jobId: string, token: string): Promise<void>;
    extendLock(
      task: string,
      jobId: string,
      token: string,
      ttl: number,
    ): Promise<"extended" | "lost" | "cancelled">;
    cancel(
      task: string,
      jobId: string,
      reason?: string,
    ): Promise<"cancelled" | "flagged" | "not_cancellable">;
    finishCancel(task: string, jobId: string, token: string): Promise<void>;
    onCancel(task: string, handler: (jobId: string) => void): Promise<() => void>;
    stalledCheck(
      task: string,
      maxStalledCount: number,
    ): Promise<{ recovered: string[]; failed: string[] }>;
    setProgress(task: string, jobId: string, value: string): Promise<void>;
    addLog(task: string, jobId: string, entry: string): Promise<void>;
    getState(task: string, jobId: string): Promise<JobState | null>;
    getResult(task: string, jobId: string): Promise<string | null>;
    getError(task: string, jobId: string): Promise<string | null>;
    getProgress(task: string, jobId: string): Promise<string | null>;
    getLogs(task: string, jobId: string): Promise<string[]>;
    subscribe(tasks: string[], handler: (event: StreamEvent) => void): Promise<() => Promise<void>>;
    awaitJob(task: string, jobId: string, timeoutMs?: number): Promise<AwaitJobResult | null>;
    // Inspector
    listJobDetails(
      task: string,
      state: "waiting" | "active" | "delayed" | "completed" | "failed" | "expired" | "cancelled",
      offset: number,
      limit: number,
    ): Promise<Array<{ id: string; details: RawJobDetails }>>;
    getJobDetails(task: string, jobId: string): Promise<RawJobDetails | null>;
    getQueueStats(task: string): Promise<QueueStats>;

    // Dead letter queue
    retryFromDLQ(task: string, jobId: string): Promise<boolean>;
    retryAllFromDLQ(task: string, limit: number): Promise<number>;

    // Retention trim
    trimDLQ(task: string, before: number, maxItems: number): Promise<number>;
    trimCompleted(task: string, before: number, maxItems: number): Promise<number>;

    getVersionDistribution(task: string): Promise<{
      waiting: Record<number, number>;
      active: Record<number, number>;
      delayed: Record<number, number>;
    }>;

    // Scheduling
    addSchedule(name: string, config: string, nextRun: number): Promise<void>;
    removeSchedule(name: string): Promise<void>;
    getSchedule(
      name: string,
    ): Promise<{ config: string; nextRun: number | null; paused: boolean } | null>;
    listSchedules(): Promise<ScheduleRecord[]>;
    tickScheduler(now: number): Promise<Array<{ name: string; config: string }>>;
    updateScheduleNextRun(name: string, config: string, nextRun: number): Promise<void>;
    pauseSchedule(name: string): Promise<void>;
    resumeSchedule(name: string, nextRun: number): Promise<void>;
    acquireSchedulerLock(token: string, ttl: number): Promise<boolean>;
    renewSchedulerLock(token: string, ttl: number): Promise<boolean>;
  }

  export interface AwaitJobResult {
    state: "completed" | "failed" | "cancelled";
    result?: string;
    error?: string;
  }

  // ── Inspector types ─────────────────────────────────────────────────

  export interface JobInfo<TData = unknown, TResult = unknown> {
    id: string;
    task: string;
    state: JobState;
    data: TData;
    result?: TResult;
    error?: string;
    progress?: number | Record<string, unknown>;
    logs: LogEntry[];
    attempt: number;
    version: number;
    timestamp: number;
    processedOn?: number;
    finishedOn?: number;
    timeline: Array<{ state: string; at: number }>;
  }

  export interface QueueStats {
    waiting: number;
    active: number;
    delayed: number;
    completed: number;
    failed: number;
    expired: number;
    cancelled: number;
  }

  export interface RawJobDetails {
    fields: Record<string, string>;
    data: string | null;
    result: string | null;
    logs: string[];
  }

  export interface InspectorListOptions {
    task?: string;
    limit?: number;
    offset?: number;
  }

  // ── Retention ────────────────────────────────────────────────────

  export interface RetentionConfig {
    maxAge?: DurationType;
    maxItems?: number;
  }

  export interface RetentionOptions {
    completed?: RetentionConfig;
    failed?: RetentionConfig;
  }

  export interface MigrationStatus {
    version: number;
    since: number;
    migrations: number;
    queue: {
      oldest: number | null;
      byVersion: Record<number, number>;
    };
    delayed: {
      oldest: number | null;
      byVersion: Record<number, number>;
    };
    canBumpSince: number;
  }

  // ── Scheduling ────────────────────────────────────────────────────

  export type Duration = DurationType;

  export type MissedPolicy = "skip" | "catch-up" | `catch-up-limit:${number}`;

  export interface ScheduleConfig {
    task: string;
    data?: unknown;
    every?: Duration;
    cron?: string;
    timezone?: string;
    onMissed?: MissedPolicy;
    overlap?: boolean;
  }

  export interface ScheduleInfo {
    name: string;
    config: ScheduleConfig;
    nextRun: number | null;
    lastRun: number | null;
    lastJobId: string | null;
    paused: boolean;
  }

  export interface SchedulerConfig {
    pollInterval?: number;
    lockTtl?: number;
  }

  export interface ScheduleRecord {
    name: string;
    config: string;
    nextRun: number | null;
  }
}
