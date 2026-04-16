import { buildResult } from "../stats.js";
import { withTimeout } from "../timeout.js";
import type { BenchAdapter, BenchmarkConfig, BenchmarkResult } from "../types.js";

const TIMEOUT = 120_000;

export async function processConcurrent(
  adapter: BenchAdapter,
  config: BenchmarkConfig,
): Promise<BenchmarkResult> {
  const queueName = `bench-process-concurrent-${Date.now()}`;

  // Warmup
  console.error("warmup...");
  const warmupHandle = await adapter.startProcessing(queueName, config.concurrency, config.warmup);
  await withTimeout(warmupHandle.done, TIMEOUT, "process-concurrent warmup");
  await adapter.cleanup();

  // Measured iterations
  const durations: number[] = [];
  for (let i = 0; i < config.iterations; i++) {
    console.error(`  iter ${i + 1}/${config.iterations}...`);
    const handle = await adapter.startProcessing(`${queueName}-${i}`, config.concurrency, config.n);
    const start = performance.now();
    await withTimeout(handle.done, TIMEOUT, `process-concurrent iter ${i}`);
    durations.push(performance.now() - start);
    await adapter.cleanup();
  }

  return buildResult(`process (c=${config.concurrency})`, adapter.name, config.n, durations);
}
