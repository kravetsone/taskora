import type { Task } from "../task.js";
import type { WorkflowHandle } from "./handle.js";

export interface WorkflowDispatchOptions {
  ttl?: import("../scheduler/duration.js").Duration;
  name?: string;
}

/**
 * A serializable, composable snapshot of a task invocation.
 * Created via `task.s()` or `task.s(data)`.
 */
export class Signature<TInput, TOutput> {
  /** @internal */
  readonly _tag = "signature" as const;
  readonly task: Task<TInput, TOutput>;
  readonly boundData: TInput | undefined;
  readonly _v: number;

  constructor(task: Task<TInput, TOutput>, data?: TInput) {
    this.task = task;
    this.boundData = data;
    this._v = task.version;
  }

  get hasBoundData(): boolean {
    return this.boundData !== undefined;
  }

  pipe<TNext>(next: Signature<TOutput, TNext>): ChainSignature<TInput, TNext> {
    return new ChainSignature<TInput, TNext>([this as AnySignature, next as AnySignature]);
  }

  dispatch(options?: WorkflowDispatchOptions): WorkflowHandle<TOutput> {
    return _dispatch(this, options);
  }
}

/**
 * A chain of signatures — sequential pipeline.
 * Result of `chain()` or `.pipe()`.
 */
export class ChainSignature<TInput, TOutput> {
  /** @internal */
  readonly _tag = "chain" as const;
  /** @internal */
  readonly steps: AnySignature[];

  constructor(steps: AnySignature[]) {
    this.steps = steps;
  }

  pipe<TNext>(next: Signature<TOutput, TNext>): ChainSignature<TInput, TNext> {
    return new ChainSignature<TInput, TNext>([...this.steps, next as AnySignature]);
  }

  dispatch(options?: WorkflowDispatchOptions): WorkflowHandle<TOutput> {
    return _dispatch(this, options);
  }
}

/**
 * A group of signatures — parallel execution, tuple result.
 */
export class GroupSignature<TOutput> {
  /** @internal */
  readonly _tag = "group" as const;
  /** @internal */
  readonly members: AnySignature[];

  constructor(members: AnySignature[]) {
    this.members = members;
  }

  dispatch(options?: WorkflowDispatchOptions): WorkflowHandle<TOutput> {
    return _dispatch(this, options);
  }
}

/**
 * A chord — group + callback. Parallel execution, then merge.
 */
export class ChordSignature<TOutput> {
  /** @internal */
  readonly _tag = "chord" as const;
  /** @internal */
  readonly header: AnySignature[];
  /** @internal */
  readonly callback: AnySignature;

  constructor(header: AnySignature[], callback: AnySignature) {
    this.header = header;
    this.callback = callback;
  }

  dispatch(options?: WorkflowDispatchOptions): WorkflowHandle<TOutput> {
    return _dispatch(this, options);
  }
}

// ── Utility types ──────────────────────────────────────────────────

export type AnySignature =
  | Signature<any, any>
  | ChainSignature<any, any>
  | GroupSignature<any>
  | ChordSignature<any>;

export type { InferOutput } from "../infer.js";
import type { InferOutput } from "../infer.js";

/** Map a tuple of compositions to a tuple of their output types. */
export type InferOutputTuple<T extends AnySignature[]> = {
  [K in keyof T]: InferOutput<T[K]>;
};

// ── Late-bound dispatch ────────────────────────────────────────────
// dispatch.ts sets this at module load via _setDispatch() to break
// the circular dependency: signature → dispatch → graph → signature.

let _dispatchFn:
  | ((comp: AnySignature, options?: WorkflowDispatchOptions) => WorkflowHandle<any>)
  | null = null;

function _dispatch<T>(comp: AnySignature, options?: WorkflowDispatchOptions): WorkflowHandle<T> {
  if (!_dispatchFn) {
    throw new Error(
      "Workflow dispatch not initialized — import from 'taskora' or 'taskora/workflow'",
    );
  }
  return _dispatchFn(comp, options);
}

/** @internal — called by dispatch.ts at module load */
export function _setDispatch(
  fn: (comp: AnySignature, options?: WorkflowDispatchOptions) => WorkflowHandle<any>,
): void {
  _dispatchFn = fn;
}
