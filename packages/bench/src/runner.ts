import { BullMQAdapter } from "./adapters/bullmq.js";
import { TaskoraAdapter } from "./adapters/taskora.js";
import { enqueueBulk } from "./benchmarks/enqueue-bulk.js";
import { enqueueSingle } from "./benchmarks/enqueue-single.js";
import { latency } from "./benchmarks/latency.js";
import { processConcurrent } from "./benchmarks/process-concurrent.js";
import { processSingle } from "./benchmarks/process-single.js";
import type { BenchAdapter, BenchmarkConfig, BenchmarkName, BenchmarkResult, LibraryName } from "./types.js";

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

function createAdapter(name: LibraryName): BenchAdapter {
  switch (name) {
    case "taskora":
      return new TaskoraAdapter();
    case "bullmq":
      return new BullMQAdapter();
  }
}

export interface RunOptions {
  libraries: LibraryName[];
  benchmarks: BenchmarkName[];
  iterations: number;
  redisUrl: string;
}

export async function run(options: RunOptions): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];

  for (const lib of options.libraries) {
    const adapter = createAdapter(lib);
    await adapter.setup(options.redisUrl);

    console.log(`\n  Running benchmarks for ${adapter.name}...`);

    for (const benchName of options.benchmarks) {
      const config = { ...DEFAULT_CONFIGS[benchName], iterations: options.iterations };
      const fn = BENCHMARK_FNS[benchName];

      process.stdout.write(`    ${benchName}... `);
      const result = await fn(adapter, config);
      console.log(`${Math.round(result.medianOpsPerSec).toLocaleString("en-US")} ops/sec`);

      results.push(result);
    }

    await adapter.teardown();
  }

  return results;
}
