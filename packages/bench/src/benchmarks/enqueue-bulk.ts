import { buildResult } from "../stats.js";
import type { BenchAdapter, BenchmarkConfig, BenchmarkResult } from "../types.js";

export async function enqueueBulk(
  adapter: BenchAdapter,
  config: BenchmarkConfig,
): Promise<BenchmarkResult> {
  const queueName = `bench-enqueue-bulk-${Date.now()}`;

  // Warmup
  await adapter.enqueueBulk(queueName, config.warmup, config.batchSize);
  await adapter.cleanup();

  // Measured iterations
  const durations: number[] = [];
  for (let i = 0; i < config.iterations; i++) {
    const start = performance.now();
    await adapter.enqueueBulk(`${queueName}-${i}`, config.n, config.batchSize);
    durations.push(performance.now() - start);
    await adapter.cleanup();
  }

  return buildResult("enqueue-bulk", adapter.name, config.n, durations);
}
