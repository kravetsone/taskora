import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// Forks + singleFork keeps behaviour consistent with the core package and
// plays nicely with Bun's Vitest-via-node-compat path (Bun's Worker
// implementation diverges from Node's in ways that break Vitest's `threads`
// pool; `forks` uses `child_process.fork` which behaves identically under
// Bun and Deno).
//
// The SWC plugin is mandatory: Vitest's default esbuild transform does NOT
// emit decorator metadata, so Nest's constructor-type DI (the zero-decorator
// `constructor(private tasks: TaskoraRef) {}` form) cannot resolve the
// dependency. SWC's `decoratorMetadata: true` mirrors what tsc does in real
// Nest apps compiled with `emitDecoratorMetadata: true`, so the tests exercise
// the same DX path users will see in production.
export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
