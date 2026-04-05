import type { RetryError } from "./errors.js";

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

  export interface TaskEventMap<TOutput> {
    completed: CompletedEvent<TOutput>;
    failed: FailedEvent;
    retrying: RetryingEvent;
    progress: ProgressEvent;
    active: ActiveEvent;
  }

  export interface AppEventMap {
    "task:completed": CompletedEvent<unknown> & { task: string };
    "task:failed": FailedEvent & { task: string };
    "task:active": ActiveEvent & { task: string };
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
    | "cancelled";

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

  export interface JobOptions {
    delay?: number;
    priority?: number;
    deduplicate?: string;
  }

  export interface RawJob {
    id: string;
    task: string;
    data: unknown;
    options: JobOptions;
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

  export interface Adapter {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    enqueue(
      task: string,
      jobId: string,
      data: string,
      options: { _v: number; maxAttempts?: number } & JobOptions,
    ): Promise<void>;
    dequeue(task: string, lockTtl: number, token: string): Promise<DequeueResult | null>;
    ack(task: string, jobId: string, token: string, result: string): Promise<void>;
    fail(
      task: string,
      jobId: string,
      token: string,
      error: string,
      retry?: { delay: number },
    ): Promise<void>;
    nack(task: string, jobId: string, token: string): Promise<void>;
    extendLock(task: string, jobId: string, token: string, ttl: number): Promise<boolean>;
    setProgress(task: string, jobId: string, value: string): Promise<void>;
    addLog(task: string, jobId: string, entry: string): Promise<void>;
    getState(task: string, jobId: string): Promise<JobState | null>;
    getResult(task: string, jobId: string): Promise<string | null>;
    getError(task: string, jobId: string): Promise<string | null>;
    getProgress(task: string, jobId: string): Promise<string | null>;
    getLogs(task: string, jobId: string): Promise<string[]>;
    subscribe(tasks: string[], handler: (event: StreamEvent) => void): Promise<() => Promise<void>>;
    awaitJob(task: string, jobId: string, timeoutMs?: number): Promise<AwaitJobResult | null>;
  }

  export interface AwaitJobResult {
    state: "completed" | "failed" | "cancelled";
    result?: string;
    error?: string;
  }
}
