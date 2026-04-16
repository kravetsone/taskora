import { buildResult, percentile } from "../stats.js";
import { withTimeout } from "../timeout.js";
import type { BenchAdapter, BenchmarkConfig, LatencyBenchmarkResult } from "../types.js";

const TIMEOUT = 60_000;

export async function latency(
  adapter: BenchAdapter,
  config: BenchmarkConfig,
): Promise<LatencyBenchmarkResult> {
  const queueName = `bench-latency-${Date.now()}`;

  // Warmup
  console.error("warmup...");
  const warmupHandle = await adapter.startLatencyRun(queueName, config.concurrency, config.warmup);
  for (let i = 0; i < config.warmup; i++) {
    await warmupHandle.dispatchOne({ i, t: performance.now() });
  }
  await withTimeout(warmupHandle.done, TIMEOUT, "latency warmup");
  await adapter.cleanup();

  // Measured iterations
  const durations: number[] = [];
  const allLatencies: number[] = [];

  for (let iter = 0; iter < config.iterations; iter++) {
    console.error(`  iter ${iter + 1}/${config.iterations}...`);
    const handle = await adapter.startLatencyRun(
      `${queueName}-${iter}`,
      config.concurrency,
      config.n,
    );

    const start = performance.now();
    for (let i = 0; i < config.n; i++) {
      await handle.dispatchOne({ i, t: performance.now() });
    }
    await withTimeout(handle.done, TIMEOUT, `latency iter ${iter}`);
    durations.push(performance.now() - start);

    allLatencies.push(...handle.getLatencies());
    await adapter.cleanup();
  }

  const sorted = [...allLatencies].sort((a, b) => a - b);

  return {
    ...buildResult("latency", adapter.name, config.n, durations),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}
