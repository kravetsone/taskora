import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["tests/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
