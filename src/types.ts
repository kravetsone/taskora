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

  export interface Adapter {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
  }
}
