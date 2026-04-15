import type { BenchmarkResult } from "./types.js";

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * (p / 100)) - 1;
  return sorted[Math.max(0, idx)]!;
}

export function buildResult(
  benchmark: string,
  library: string,
  ops: number,
  durations: number[],
  memorySamples?: number[],
): BenchmarkResult {
  const medianMs = median(durations);
  const medianOpsPerSec = medianMs > 0 ? (ops / medianMs) * 1000 : 0;

  const result: BenchmarkResult = {
    benchmark,
    library,
    ops,
    durationMs: median(durations),
    opsPerSec: medianOpsPerSec,
    iterations: durations,
    medianOpsPerSec,
  };

  if (memorySamples && memorySamples.length > 0) {
    // Ignore negative deltas (can happen if Redis shrinks allocator chunks
    // between samples) so they don't pull the median down.
    const nonNegative = memorySamples.filter((b) => b >= 0);
    const samples = nonNegative.length > 0 ? nonNegative : memorySamples;
    const med = median(samples);
    result.memoryBytes = med;
    result.memoryPerJob = ops > 0 ? Math.round(med / ops) : 0;
  }

  return result;
}
