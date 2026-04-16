import type { BenchmarkResult, LatencyBenchmarkResult } from "./types.js";

function isLatencyResult(r: BenchmarkResult): r is LatencyBenchmarkResult {
  return "p50" in r;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${Math.round(n)} B`;
}

function pad(s: string, len: number): string {
  return s.padEnd(len);
}

function padStart(s: string, len: number): string {
  return s.padStart(len);
}

export interface ReportContext {
  store: string;
  runtime: string;
  redisUrl?: string;
}

export function reportTable(results: BenchmarkResult[], ctx: ReportContext): void {
  console.log();
  console.log("  Benchmark Suite: taskora vs BullMQ");
  console.log(`  Store:   ${ctx.store}`);
  console.log(`  Runtime: ${ctx.runtime}`);
  if (ctx.redisUrl) console.log(`  Redis:   ${ctx.redisUrl}`);
  console.log();

  const colBench = 24;
  const colLib = 10;
  const colOps = 12;
  const colMedian = 12;
  const colJobs = 7;
  const colMem = 12;
  const colPerJob = 10;
  const colLatency = 22;

  const header = [
    pad("Benchmark", colBench),
    pad("Library", colLib),
    padStart("Ops/sec", colOps),
    padStart("Median(ms)", colMedian),
    padStart("Jobs", colJobs),
    padStart("Mem Δ", colMem),
    padStart("B/job", colPerJob),
    padStart("Latency p50/p95/p99", colLatency),
  ].join("  ");

  const separator = [
    "─".repeat(colBench),
    "─".repeat(colLib),
    "─".repeat(colOps),
    "─".repeat(colMedian),
    "─".repeat(colJobs),
    "─".repeat(colMem),
    "─".repeat(colPerJob),
    "─".repeat(colLatency),
  ].join("  ");

  console.log(`  ${header}`);
  console.log(`  ${separator}`);

  for (const r of results) {
    const latencyStr = isLatencyResult(r)
      ? `${fmt(r.p50)}/${fmt(r.p95)}/${fmt(r.p99)}`
      : "—";

    const memStr = r.memoryBytes !== undefined ? fmtBytes(r.memoryBytes) : "—";
    const perJobStr =
      r.memoryPerJob !== undefined && r.memoryPerJob > 0 ? fmtBytes(r.memoryPerJob) : "—";

    const row = [
      pad(r.benchmark, colBench),
      pad(r.library, colLib),
      padStart(fmt(r.medianOpsPerSec), colOps),
      padStart(fmt(r.durationMs), colMedian),
      padStart(String(r.ops), colJobs),
      padStart(memStr, colMem),
      padStart(perJobStr, colPerJob),
      padStart(latencyStr, colLatency),
    ].join("  ");

    console.log(`  ${row}`);
  }

  console.log();
}

export function reportJSON(results: BenchmarkResult[], ctx: ReportContext): void {
  console.log(JSON.stringify({ store: ctx.store, runtime: ctx.runtime, results }, null, 2));
}
