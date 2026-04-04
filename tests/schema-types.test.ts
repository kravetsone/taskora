import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { taskora } from "../src/index.js";
import type { Task } from "../src/task.js";

describe("schema type inference", () => {
  it("infers TInput from input schema", () => {
    const app = taskora({ adapter: {} as any });

    const task = app.task("typed", {
      input: z.object({ name: z.string(), age: z.number() }),
      handler: async (data) => {
        expectTypeOf(data).toEqualTypeOf<{ name: string; age: number }>();
        return null;
      },
    });

    expectTypeOf(task).toMatchTypeOf<Task<{ name: string; age: number }, null>>();
  });

  it("infers TOutput from output schema", () => {
    const app = taskora({ adapter: {} as any });

    const task = app.task("typed-output", {
      input: z.object({ url: z.string() }),
      output: z.object({ size: z.number() }),
      handler: async (data) => {
        expectTypeOf(data).toEqualTypeOf<{ url: string }>();
        return { size: 42 };
      },
    });

    expectTypeOf(task).toMatchTypeOf<Task<{ url: string }, { size: number }>>();
  });

  it("falls back to handler signature when no schema", () => {
    const app = taskora({ adapter: {} as any });

    const task = app.task("manual", async (data: { x: number }) => {
      return { y: data.x * 2 };
    });

    expectTypeOf(task).toMatchTypeOf<Task<{ x: number }, { y: number }>>();
  });

  it("dispatch accepts the inferred input type", () => {
    const app = taskora({ adapter: {} as any });

    const task = app.task("dispatch-typed", {
      input: z.object({ email: z.string() }),
      handler: async (data) => null,
    });

    expectTypeOf(task.dispatch).parameter(0).toEqualTypeOf<{ email: string }>();
  });
});
