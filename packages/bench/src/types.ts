export interface BenchAdapter {
  readonly name: string;

  /** Connect to Redis, prepare internal clients. */
  setup(redisUrl: string): Promise<void>;

  /** Enqueue `count` jobs one at a time. */
  enqueueSingle(queueName: string, count: number): Promise<void>;

  /** Enqueue `count` jobs in batches of `batchSize`. */
  enqueueBulk(queueName: string, count: number, batchSize: number): Promise<void>;

  /**
   * Pre-enqueue `count` jobs, then start a worker with the given concurrency.
   * Returns a handle whose `.done` resolves when all jobs are processed.
   */
  startProcessing(
    queueName: string,
    concurrency: number,
    count: number,
  ): Promise<CompletionHandle>;

  /**
   * Start a worker for latency measurement. The caller dispatches jobs
   * via `dispatchOne` with a timestamp; the handler records arrival time.
   */
  startLatencyRun(
    queueName: string,
    concurrency: number,
    count: number,
  ): Promise<LatencyHandle>;

  /** FLUSHDB — clean Redis between iterations. */
  cleanup(): Promise<void>;

  /** Close all connections. Called once at end. */
  teardown(): Promise<void>;

  /** Current Redis `used_memory` in bytes (from `INFO memory`). */
  getMemoryUsage(): Promise<number>;
}

export interface CompletionHandle {
  /** Resolves when `count` jobs have been processed. */
  done: Promise<void>;
}

export interface LatencyHandle extends CompletionHandle {
  /** Dispatch a single job with embedded timestamp. */
  dispatchOne(data: { i: number; t: number }): Promise<void>;
  /** Collected latencies (arrival - dispatch) in ms. */
  getLatencies(): number[];
}

export interface BenchmarkResult {
  benchmark: string;
  library: string;
  ops: number;
  durationMs: number;
  opsPerSec: number;
  /** Raw durations (ms) per iteration. */
  iterations: number[];
  medianOpsPerSec: number;
  /** Median Redis memory delta (bytes) across iterations — only populated for enqueue benchmarks. */
  memoryBytes?: number;
  /** memoryBytes / ops, rounded bytes per job. */
  memoryPerJob?: number;
}

export interface LatencyBenchmarkResult extends BenchmarkResult {
  p50: number;
  p95: number;
  p99: number;
}

export interface BenchmarkConfig {
  n: number;
  warmup: number;
  batchSize: number;
  concurrency: number;
  iterations: number;
}

export type BenchmarkName =
  | "enqueue-single"
  | "enqueue-bulk"
  | "process-single"
  | "process-concurrent"
  | "latency";

export type LibraryName = "taskora" | "taskora-bun" | "bullmq";

export type StoreName = "redis" | "valkey" | "dragonfly";

export interface RunConfig {
  libraries: LibraryName[];
  benchmarks: BenchmarkName[];
  store: StoreName;
  iterations: number;
  json: boolean;
}
