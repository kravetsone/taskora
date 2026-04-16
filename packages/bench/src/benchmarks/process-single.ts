import { buildResult } from "../stats.js";
import { withTimeout } from "../timeout.js";
import type { BenchAdapter, BenchmarkConfig, BenchmarkResult } from "../types.js";

const TIMEOUT = 60_000;

export async function processSingle(
  adapter: BenchAdapter,
  config: BenchmarkConfig,
): Promise<BenchmarkResult> {
  const queueName = `bench-process-single-${Date.now()}`;

  // Warmup
  console.error("warmup...");
  const warmupHandle = await adapter.startProcessing(queueName, 1, config.warmup);
  await withTimeout(warmupHandle.done, TIMEOUT, "process-single warmup");
  await adapter.cleanup();

  // Measured iterations
  const durations: number[] = [];
  for (let i = 0; i < config.iterations; i++) {
    console.error(`  iter ${i + 1}/${config.iterations}...`);
    const handle = await adapter.startProcessing(`${queueName}-${i}`, 1, config.n);
    const start = performance.now();
    await withTimeout(handle.done, TIMEOUT, `process-single iter ${i}`);
    durations.push(performance.now() - start);
    await adapter.cleanup();
  }

  return buildResult("process (c=1)", adapter.name, config.n, durations);
}
