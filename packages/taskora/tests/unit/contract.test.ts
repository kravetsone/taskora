import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as z from "zod";
import {
  type TaskContract,
  defineTask,
  isTaskContract,
  staticContract,
} from "../../src/contract.js";

describe("defineTask", () => {
  it("creates a contract with name, brand, and schemas", () => {
    const task = defineTask({
      name: "send-email",
      input: z.object({ to: z.string(), subject: z.string() }),
      output: z.object({ messageId: z.string() }),
    });

    expect(task.__kind).toBe("TaskContract");
    expect(task.name).toBe("send-email");
    expect(task.input).toBeDefined();
    expect(task.output).toBeDefined();
  });

  it("infers TInput and TOutput from Standard Schemas", () => {
    const task = defineTask({
      name: "process-image",
      input: z.object({ url: z.string(), width: z.number() }),
      output: z.object({ thumbnails: z.array(z.string()) }),
    });

    expectTypeOf(task).toMatchTypeOf<
      TaskContract<{ url: string; width: number }, { thumbnails: string[] }>
    >();
  });

  it("propagates retry, timeout, stall, and version defaults", () => {
    const task = defineTask({
      name: "critical-job",
      input: z.object({ payload: z.string() }),
      retry: { attempts: 5, backoff: "exponential", maxDelay: 30_000 },
      timeout: "60s",
      stall: { interval: 10_000, maxCount: 2 },
      version: 3,
    });

    expect(task.retry).toEqual({
      attempts: 5,
      backoff: "exponential",
      maxDelay: 30_000,
    });
    expect(task.timeout).toBe("60s");
    expect(task.stall).toEqual({ interval: 10_000, maxCount: 2 });
    expect(task.version).toBe(3);
  });

  it("works with any Standard Schema vendor (manual implementation)", () => {
    // Minimal custom Standard Schema — no Zod — proves vendor independence.
    interface UserInput {
      id: number;
    }
    const customInputSchema: StandardSchemaV1<unknown, UserInput> = {
      "~standard": {
        version: 1,
        vendor: "custom",
        validate: (value) => {
          if (
            typeof value === "object" &&
            value !== null &&
            "id" in value &&
            typeof (value as { id: unknown }).id === "number"
          ) {
            return { value: value as UserInput };
          }
          return { issues: [{ message: "Expected { id: number }" }] };
        },
      },
    };

    const task = defineTask({
      name: "fetch-user",
      input: customInputSchema,
    });

    expect(task.name).toBe("fetch-user");
    expect(task.input).toBe(customInputSchema);
    expectTypeOf(task).toMatchTypeOf<TaskContract<UserInput, unknown>>();
  });
});

describe("staticContract", () => {
  it("creates a typeless contract with no runtime schemas", () => {
    const task = staticContract<{ to: string; subject: string }, { messageId: string }>({
      name: "send-email",
    });

    expect(task.__kind).toBe("TaskContract");
    expect(task.name).toBe("send-email");
    expect(task.input).toBeUndefined();
    expect(task.output).toBeUndefined();
  });

  it("carries TInput/TOutput phantom types for compile-time safety", () => {
    const task = staticContract<{ url: string; width: number }, { key: string }>({
      name: "process-image",
      version: 2,
    });

    expectTypeOf(task).toMatchTypeOf<
      TaskContract<{ url: string; width: number }, { key: string }>
    >();
    expect(task.version).toBe(2);
  });
});

describe("isTaskContract", () => {
  it("returns true for contracts created via defineTask", () => {
    const task = defineTask({ name: "a", input: z.object({ x: z.string() }) });
    expect(isTaskContract(task)).toBe(true);
  });

  it("returns true for contracts created via staticContract", () => {
    const task = staticContract<{ x: number }, void>({ name: "b" });
    expect(isTaskContract(task)).toBe(true);
  });

  it("returns false for non-contract values", () => {
    expect(isTaskContract(null)).toBe(false);
    expect(isTaskContract(undefined)).toBe(false);
    expect(isTaskContract({})).toBe(false);
    expect(isTaskContract({ name: "send-email" })).toBe(false);
    expect(isTaskContract({ __kind: "something-else", name: "x" })).toBe(false);
    expect(isTaskContract("send-email")).toBe(false);
    expect(isTaskContract(42)).toBe(false);
  });
});
