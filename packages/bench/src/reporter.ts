import type { BenchmarkResult, LatencyBenchmarkResult } from "./types.js";

function isLatencyResult(r: BenchmarkResult): r is LatencyBenchmarkResult {
  return "p50" in r;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

function pad(s: string, len: number): string {
  return s.padEnd(len);
}

function padStart(s: string, len: number): string {
  return s.padStart(len);
}

export function reportTable(results: BenchmarkResult[], redisUrl: string): void {
  console.log();
  console.log("  Benchmark Suite: taskora vs BullMQ");
  console.log(`  Redis: ${redisUrl}`);
  console.log();

  const colBench = 24;
  const colLib = 10;
  const colOps = 12;
  const colMedian = 12;
  const colJobs = 7;
  const colLatency = 22;

  const header = [
    pad("Benchmark", colBench),
    pad("Library", colLib),
    padStart("Ops/sec", colOps),
    padStart("Median(ms)", colMedian),
    padStart("Jobs", colJobs),
    padStart("Latency p50/p95/p99", colLatency),
  ].join("  ");

  const separator = [
    "─".repeat(colBench),
    "─".repeat(colLib),
    "─".repeat(colOps),
    "─".repeat(colMedian),
    "─".repeat(colJobs),
    "─".repeat(colLatency),
  ].join("  ");

  console.log(`  ${header}`);
  console.log(`  ${separator}`);

  for (const r of results) {
    const latencyStr = isLatencyResult(r)
      ? `${fmt(r.p50)}/${fmt(r.p95)}/${fmt(r.p99)}`
      : "—";

    const row = [
      pad(r.benchmark, colBench),
      pad(r.library, colLib),
      padStart(fmt(r.medianOpsPerSec), colOps),
      padStart(fmt(r.durationMs), colMedian),
      padStart(String(r.ops), colJobs),
      padStart(latencyStr, colLatency),
    ].join("  ");

    console.log(`  ${row}`);
  }

  console.log();
}

export function reportJSON(results: BenchmarkResult[]): void {
  console.log(JSON.stringify(results, null, 2));
}
