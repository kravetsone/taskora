// Parameterized `redisAdapter` for the integration suite.
//
// Integration tests import `redisAdapter` from HERE instead of
// `src/redis/index.js` so the same test files can run against any driver.
// The driver is picked from `TASKORA_TEST_DRIVER`:
//
//   TASKORA_TEST_DRIVER=ioredis  (default) → src/redis/ioredis.js
//   TASKORA_TEST_DRIVER=bun               → src/redis/bun.js
//
// Resolution happens at module load via top-level await, so call-sites keep
// the familiar synchronous `redisAdapter(url())` shape. (TLA is supported in
// Node 14.8+, Bun, and Deno under our `"module": "NodeNext"` config.)
//
// Tests that exercise driver-specific constructor forms (e.g. passing a
// pre-built ioredis `Redis` instance) can guard with `it.skipIf(!isIoredis)`.

import type { Taskora } from "../src/types.js";

type DriverName = "ioredis" | "bun";

const driverName = (process.env.TASKORA_TEST_DRIVER ?? "ioredis") as DriverName;

if (driverName !== "ioredis" && driverName !== "bun") {
  throw new Error(`Unknown TASKORA_TEST_DRIVER=${driverName}. Expected "ioredis" or "bun".`);
}

if (driverName === "bun" && typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
  throw new Error(
    "TASKORA_TEST_DRIVER=bun requires the Bun runtime — run the suite via " +
      "`bun run test:bun` (or `bunx --bun vitest run`). On Node.js, either " +
      "omit TASKORA_TEST_DRIVER or set it to `ioredis`.",
  );
}

const module =
  driverName === "bun"
    ? await import("../src/redis/bun.js")
    : await import("../src/redis/ioredis.js");

/**
 * Construct a `Taskora.Adapter` backed by whichever Redis driver the env
 * variable selected. The signature is intentionally loose (`unknown`) because
 * the two factories accept different pre-built-client shapes; tests passing
 * anything other than a URL string should gate on `isIoredis`/`isBun`.
 */
export const redisAdapter: (connection: unknown, options?: { prefix?: string }) => Taskora.Adapter =
  module.redisAdapter as never;

export const currentTestDriver: DriverName = driverName;
export const isIoredis = driverName === "ioredis";
export const isBun = driverName === "bun";
