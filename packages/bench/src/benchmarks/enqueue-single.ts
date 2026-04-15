import { buildResult } from "../stats.js";
import type { BenchAdapter, BenchmarkConfig, BenchmarkResult } from "../types.js";

export async function enqueueSingle(
  adapter: BenchAdapter,
  config: BenchmarkConfig,
): Promise<BenchmarkResult> {
  const queueName = `bench-enqueue-single-${Date.now()}`;

  // Warmup
  await adapter.enqueueSingle(queueName, config.warmup);
  await adapter.cleanup();

  // Measured iterations
  const durations: number[] = [];
  const memoryDeltas: number[] = [];
  for (let i = 0; i < config.iterations; i++) {
    const memBefore = await adapter.getMemoryUsage();
    const start = performance.now();
    await adapter.enqueueSingle(`${queueName}-${i}`, config.n);
    durations.push(performance.now() - start);
    const memAfter = await adapter.getMemoryUsage();
    memoryDeltas.push(memAfter - memBefore);
    await adapter.cleanup();
  }

  return buildResult("enqueue-single", adapter.name, config.n, durations, memoryDeltas);
}
