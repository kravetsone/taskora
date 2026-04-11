import { defineConfig } from "vitest/config";

// Single project for now — board only ships unit tests that exercise the
// in-memory adapter (no testcontainers-Redis). `pool: forks` + `singleFork`
// keeps us compatible with Bun's and Deno's Vitest compat paths.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
});
