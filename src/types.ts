export namespace Taskora {
  export type JobState =
    | "waiting"
    | "delayed"
    | "active"
    | "completed"
    | "failed"
    | "retrying"
    | "cancelled";

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

  export interface Context {
    id: string;
    attempt: number;
    timestamp: number;
    signal: AbortSignal;
    heartbeat(): void;
  }

  export interface Adapter {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    enqueue(task: string, data: string, options: { _v: number } & JobOptions): Promise<string>;
    dequeue(task: string, lockTtl: number, token: string): Promise<DequeueResult | null>;
    ack(task: string, jobId: string, token: string, result: string): Promise<void>;
    fail(task: string, jobId: string, token: string, error: string): Promise<void>;
    nack(task: string, jobId: string, token: string): Promise<void>;
    extendLock(task: string, jobId: string, token: string, ttl: number): Promise<boolean>;
  }
}
