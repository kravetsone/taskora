import events from "node:events";
import { setupRedis, teardownRedis } from "./redis.js";
import { reportJSON, reportTable } from "./reporter.js";
import { run } from "./runner.js";
import type { BenchmarkName, LibraryName, RunConfig, StoreName } from "./types.js";

// BullMQ + taskora create many internal ioredis connections — suppress
// MaxListeners warnings and ioredis reconnect noise during teardown.
events.defaultMaxListeners = 100;

const _consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === "string" && first.includes("[ioredis]")) return;
  _consoleError(...args);
};

// Suppress Node process warnings (MaxListenersExceeded, etc.)
process.removeAllListeners("warning");
process.on("warning", () => {});

const ALL_LIBRARIES: LibraryName[] = ["taskora", "bullmq"];
const ALL_BENCHMARKS: BenchmarkName[] = [
  "enqueue-single",
  "enqueue-bulk",
  "process-single",
  "process-concurrent",
  "latency",
];
const VALID_STORES: StoreName[] = ["redis", "valkey", "dragonfly"];

export function detectRuntime(): string {
  if (typeof globalThis.Bun !== "undefined") return "bun";
  // @ts-expect-error -- Deno global
  if (typeof globalThis.Deno !== "undefined") return "deno";
  return `node ${process.version}`;
}

function parseArgs(): RunConfig {
  const args = process.argv.slice(2);
  const config: RunConfig = {
    libraries: ALL_LIBRARIES,
    benchmarks: ALL_BENCHMARKS,
    store: "redis",
    iterations: 3,
    json: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--libraries" && args[i + 1]) {
      config.libraries = args[++i]!.split(",") as LibraryName[];
    } else if (arg === "--benchmarks" && args[i + 1]) {
      config.benchmarks = args[++i]!.split(",") as BenchmarkName[];
    } else if (arg === "--store" && args[i + 1]) {
      const store = args[++i]! as StoreName;
      if (!VALID_STORES.includes(store)) {
        console.error(`Invalid store: ${store}. Valid: ${VALID_STORES.join(", ")}`);
        process.exit(1);
      }
      config.store = store;
    } else if (arg === "--iterations" && args[i + 1]) {
      config.iterations = Number.parseInt(args[++i]!, 10);
    } else if (arg === "--json") {
      config.json = true;
    }
  }

  return config;
}

async function main() {
  const config = parseArgs();
  const runtime = detectRuntime();

  console.log(`  Runtime: ${runtime}`);
  console.log(`  Store:   ${config.store}`);

  const redisUrl = await setupRedis(config.store);
  console.log(`  URL:     ${redisUrl}`);

  try {
    const results = await run({
      libraries: config.libraries,
      benchmarks: config.benchmarks,
      iterations: config.iterations,
      redisUrl,
    });

    if (config.json) {
      reportJSON(results, { store: config.store, runtime });
    } else {
      reportTable(results, { store: config.store, runtime, redisUrl });
    }
  } finally {
    await teardownRedis();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
