import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Duration } from "./scheduler/duration.js";
import type { Taskora } from "./types.js";

declare const phantomInput: unique symbol;
declare const phantomOutput: unique symbol;

/**
 * A task contract — a pure, serializable declaration of a task's name,
 * schemas, and defaults.
 *
 * Contracts have no runtime dependency on `App`, `Worker`, or `Adapter`. A
 * producer service can import and dispatch contracts without pulling in
 * handler code. A worker service attaches a handler via
 * `taskora.implement(contract, handler)`.
 *
 * Create a contract with {@link defineTask} (runtime schemas) or
 * {@link staticContract} (types only).
 */
export interface TaskContract<TInput = unknown, TOutput = unknown> {
  readonly __kind: "TaskContract";
  readonly name: string;
  readonly input?: StandardSchemaV1<unknown, TInput>;
  readonly output?: StandardSchemaV1<unknown, TOutput>;
  readonly retry?: Taskora.RetryConfig;
  readonly timeout?: Duration;
  readonly stall?: Taskora.StallConfig;
  readonly version?: number;
  /** @internal — phantom type carriers, never populated at runtime. */
  readonly [phantomInput]?: TInput;
  readonly [phantomOutput]?: TOutput;
}

/** Configuration accepted by {@link defineTask}. */
export interface DefineTaskConfig<TInput, TOutput> {
  name: string;
  input?: StandardSchemaV1<unknown, TInput>;
  output?: StandardSchemaV1<unknown, TOutput>;
  retry?: Taskora.RetryConfig;
  timeout?: Duration;
  stall?: Taskora.StallConfig;
  version?: number;
}

/**
 * Define a task contract with runtime schemas. Input and output types are
 * inferred from the schemas automatically — any Standard Schema compatible
 * library works (Zod, Valibot, ArkType, etc).
 *
 * @example
 * ```ts
 * import { defineTask } from "taskora"
 * import { z } from "zod"
 *
 * export const sendEmailTask = defineTask({
 *   name: "send-email",
 *   input: z.object({ to: z.email(), subject: z.string() }),
 *   output: z.object({ messageId: z.string() }),
 *   retry: { attempts: 3, backoff: "exponential" },
 * })
 * ```
 */
export function defineTask<TInput = unknown, TOutput = unknown>(
  config: DefineTaskConfig<TInput, TOutput>,
): TaskContract<TInput, TOutput> {
  return {
    __kind: "TaskContract",
    name: config.name,
    input: config.input,
    output: config.output,
    retry: config.retry,
    timeout: config.timeout,
    stall: config.stall,
    version: config.version,
  };
}

/** Configuration accepted by {@link staticContract}. */
export interface StaticContractConfig {
  name: string;
  retry?: Taskora.RetryConfig;
  timeout?: Duration;
  stall?: Taskora.StallConfig;
  version?: number;
}

/**
 * Define a type-only task contract with no runtime schemas. Use this for
 * bundle-size-sensitive producers (edge runtimes, browsers) where you want
 * compile-time safety without shipping Zod/Valibot at runtime.
 *
 * The worker side should still validate its input — either by swapping
 * {@link staticContract} for {@link defineTask} in the worker-side module,
 * or by providing schemas at `implement()` time.
 *
 * @example
 * ```ts
 * import { staticContract } from "taskora"
 *
 * export const sendEmailTask = staticContract<
 *   { to: string; subject: string },
 *   { messageId: string }
 * >({ name: "send-email" })
 * ```
 */
export function staticContract<TInput = unknown, TOutput = unknown>(
  config: StaticContractConfig,
): TaskContract<TInput, TOutput> {
  return {
    __kind: "TaskContract",
    name: config.name,
    retry: config.retry,
    timeout: config.timeout,
    stall: config.stall,
    version: config.version,
  };
}

/** Runtime type guard for task contracts. */
export function isTaskContract(value: unknown): value is TaskContract {
  return (
    typeof value === "object" &&
    value !== null &&
    "__kind" in value &&
    (value as { __kind: unknown }).__kind === "TaskContract"
  );
}
