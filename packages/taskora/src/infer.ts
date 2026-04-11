import type { BoundTask } from "./bound-task.js";
import type { TaskContract } from "./contract.js";
import type { ResultHandle } from "./result.js";
import type { Task } from "./task.js";
import type { WorkflowHandle } from "./workflow/handle.js";
import type {
  ChainSignature,
  ChordSignature,
  GroupSignature,
  Signature,
} from "./workflow/signature.js";

/**
 * Infer the input type of anything that carries one: `Task`, `BoundTask`,
 * `TaskContract`, or a `Signature` produced by `task.s()`.
 *
 * For handle types that only carry an output (`ResultHandle`,
 * `WorkflowHandle`, group/chord signatures) this resolves to `never`.
 *
 * @example
 * ```ts
 * import type { InferInput } from "taskora"
 *
 * const sendEmailTask = defineTask({
 *   name: "send-email",
 *   input: z.object({ to: z.string(), subject: z.string() }),
 * })
 *
 * type EmailInput = InferInput<typeof sendEmailTask>
 * // { to: string; subject: string }
 * ```
 */
export type InferInput<T> = T extends TaskContract<infer I, any>
  ? I
  : T extends Task<infer I, any>
    ? I
    : T extends BoundTask<infer I, any>
      ? I
      : T extends Signature<infer I, any>
        ? I
        : T extends ChainSignature<infer I, any>
          ? I
          : never;

/**
 * Infer the output type of anything that carries one: `Task`, `BoundTask`,
 * `TaskContract`, `ResultHandle`, `WorkflowHandle`, or any workflow
 * `Signature` (`Signature`, `ChainSignature`, `GroupSignature`,
 * `ChordSignature`).
 *
 * This supersedes the previous workflow-only `InferOutput` — workflow code
 * that already uses it keeps working since `Signature` variants are still
 * handled.
 *
 * @example
 * ```ts
 * import type { InferOutput } from "taskora"
 *
 * const processImageTask = defineTask({
 *   name: "process-image",
 *   input: z.object({ url: z.string() }),
 *   output: z.object({ width: z.number(), height: z.number() }),
 * })
 *
 * type ImageResult = InferOutput<typeof processImageTask>
 * // { width: number; height: number }
 *
 * const handle = processImageTask.dispatch({ url: "..." })
 * type SameResult = InferOutput<typeof handle>
 * // { width: number; height: number }
 * ```
 */
export type InferOutput<T> = T extends TaskContract<any, infer O>
  ? O
  : T extends Task<any, infer O>
    ? O
    : T extends BoundTask<any, infer O>
      ? O
      : T extends ResultHandle<infer O>
        ? O
        : T extends WorkflowHandle<infer O>
          ? O
          : T extends Signature<any, infer O>
            ? O
            : T extends ChainSignature<any, infer O>
              ? O
              : T extends GroupSignature<infer O>
                ? O
                : T extends ChordSignature<infer O>
                  ? O
                  : never;
