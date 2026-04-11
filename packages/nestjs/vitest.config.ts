import { defineConfig } from "vitest/config";

// Forks + singleFork keeps behaviour consistent with the core package and
// plays nicely with Bun's Vitest-via-node-compat path (Bun's Worker
// implementation diverges from Node's in ways that break Vitest's `threads`
// pool; `forks` uses `child_process.fork` which behaves identically under
// Bun and Deno).
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
