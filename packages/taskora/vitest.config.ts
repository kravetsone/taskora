import { defineConfig } from "vitest/config";

// Split into two projects so the `unit` suite doesn't pay the
// testcontainers-Redis startup cost that `integration` needs. `pool: forks`
// + `singleFork: true` is kept on both because it's the only combination
// that runs reliably under Bun's Vitest-via-node-compat path (Bun's Worker
// implementation diverges from Node's in ways that break Vitest's `threads`
// pool; `forks` uses `child_process.fork` which behaves identically under
// Bun and Deno).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: [
            "tests/unit/**/*.test.ts",
            "tests/schema.test.ts",
            "tests/schema-types.test.ts",
            "tests/infer-types.test.ts",
          ],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts", "tests/smoke.test.ts"],
          globalSetup: ["tests/setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
});
