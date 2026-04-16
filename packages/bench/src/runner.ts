import { BullMQAdapter } from "./adapters/bullmq.js";
import { TaskoraAdapter } from "./adapters/taskora.js";
import { enqueueBulk } from "./benchmarks/enqueue-bulk.js";
import { enqueueSingle } from "./benchmarks/enqueue-single.js";
import { latency } from "./benchmarks/latency.js";
import { processConcurrent } from "./benchmarks/process-concurrent.js";
import { processSingle } from "./benchmarks/process-single.js";
import type {
  BenchAdapter,
  BenchmarkConfig,
  BenchmarkName,
  BenchmarkResult,
  LibraryName,
} from "./types.js";

async function createTaskoraBunAdapter(): Promise<BenchAdapter> {
  const { TaskoraBunAdapter } = await import("./adapters/taskora-bun.js");
  return new TaskoraBunAdapter();
}

const DEFAULT_CONFIGS: Record<BenchmarkName, BenchmarkConfig> = {
  "enqueue-single": { n: 1000, warmup: 500, batchSize: 50, concurrency: 1, iterations: 3 },
  "enqueue-bulk": { n: 10_000, warmup: 500, batchSize: 50, concurrency: 1, iterations: 3 },
  "process-single": { n: 1000, warmup: 200, batchSize: 50, concurrency: 1, iterations: 3 },
  "process-concurrent": { n: 10_000, warmup: 200, batchSize: 50, concurrency: 100, iterations: 3 },
  latency: { n: 1000, warmup: 100, batchSize: 50, concurrency: 10, iterations: 3 },
};

type BenchmarkFn = (adapter: BenchAdapter, config: BenchmarkConfig) => Promise<BenchmarkResult>;

const BENCHMARK_FNS: Record<BenchmarkName, BenchmarkFn> = {
  "enqueue-single": enqueueSingle,
  "enqueue-bulk": enqueueBulk,
  "process-single": processSingle,
  "process-concurrent": processConcurrent,
  latency: latency,
};

async function createAdapter(name: LibraryName): Promise<BenchAdapter> {
  switch (name) {
    case "taskora":
      return new TaskoraAdapter();
    case "taskora-bun":
      return createTaskoraBunAdapter();
    case "bullmq":
      return new BullMQAdapter();
  }
}

export interface RunOptions {
  libraries: LibraryName[];
  benchmarks: BenchmarkName[];
  iterations: number;
  redisUrl: string;
  /** Where to send progress output. Defaults to stdout. */
  log?: (msg: string) => void;
}

export async function run(options: RunOptions): Promise<BenchmarkResult[]> {
  const log = options.log ?? ((msg: string) => process.stderr.write(msg));
  const results: BenchmarkResult[] = [];

  for (const lib of options.libraries) {
    const adapter = await createAdapter(lib);
    await adapter.setup(options.redisUrl);

    log(`\n  Running benchmarks for ${adapter.name}...\n`);

    for (const benchName of options.benchmarks) {
      const config = { ...DEFAULT_CONFIGS[benchName], iterations: options.iterations };
      const fn = BENCHMARK_FNS[benchName];

      log(`    ${benchName}... `);
      const result = await fn(adapter, config);
      const opsStr = `${Math.round(result.medianOpsPerSec).toLocaleString("en-US")} ops/sec`;
      const memStr =
        result.memoryPerJob !== undefined && result.memoryPerJob > 0
          ? ` (${result.memoryPerJob.toLocaleString("en-US")} B/job)`
          : "";
      log(`${opsStr}${memStr}\n`);

      results.push(result);
    }

    await adapter.teardown();
  }

  return results;
}
