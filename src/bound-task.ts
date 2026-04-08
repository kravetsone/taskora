import type { TaskContract } from "./contract.js";
import type { ResultHandle } from "./result.js";
import type { Task } from "./task.js";
import type { Taskora } from "./types.js";
import type { WorkflowHandle } from "./workflow/handle.js";
import type { Signature } from "./workflow/signature.js";

/**
 * A dispatchable view of a task that was declared via a {@link TaskContract}.
 *
 * Returned by `taskora.register(contract)` and `taskora.implement(contract, ...)`.
 * Thin wrapper over the internal `Task` — all dispatch semantics (retries,
 * delays, debounce, throttle, deduplicate, TTL, concurrency) work identically.
 *
 * Producer processes use `BoundTask` to dispatch without importing handler code.
 * Worker processes get the same `BoundTask` back from `implement()` so they can
 * still dispatch from within handlers (e.g. chaining).
 */
export class BoundTask<TInput, TOutput> {
  /** @internal — used by App to share the underlying Task between register/implement */
  readonly _task: Task<TInput, TOutput>;

  constructor(task: Task<TInput, TOutput>) {
    this._task = task;
  }

  /** The task's canonical name (kebab-case, e.g. `"send-email"`). */
  get name(): string {
    return this._task.name;
  }

  /**
   * Dispatch a job. Returns a {@link ResultHandle} for awaiting the result,
   * querying state, or cancelling. Identical semantics to `Task.dispatch`.
   */
  dispatch(data: TInput, options?: Taskora.DispatchOptions): ResultHandle<TOutput> {
    return this._task.dispatch(data, options);
  }

  /** Dispatch multiple jobs in one call. Returns one {@link ResultHandle} per job. */
  dispatchMany(
    jobs: Array<{ data: TInput; options?: Taskora.DispatchOptions }>,
  ): ResultHandle<TOutput>[] {
    return this._task.dispatchMany(jobs);
  }

  /**
   * Subscribe to task lifecycle events. Works in producer-only processes —
   * events are delivered via `adapter.subscribe()` on an XREAD connection,
   * independent of whether a worker loop runs locally.
   */
  on<K extends keyof Taskora.TaskEventMap<TOutput> & string>(
    event: K,
    handler: (data: Taskora.TaskEventMap<TOutput>[K]) => void,
  ): () => void {
    return this._task.on(event, handler);
  }

  /**
   * Create a {@link Signature} — a composable snapshot of this task
   * invocation for use in `chain()`, `group()`, or `chord()` workflows.
   *
   * Contracts must be `register()`ed before composition: the returned
   * signature carries a reference back to the underlying `Task`, which
   * is how the workflow dispatcher resolves adapter and serializer at
   * dispatch time.
   *
   * @example
   * ```ts
   * import { chain } from "taskora"
   * const fetchUser = taskora.register(fetchUserContract)
   * const sendEmail = taskora.register(sendEmailContract)
   * await chain(fetchUser.s({ id: "42" }), sendEmail.s()).dispatch()
   * ```
   */
  s(data?: TInput): Signature<TInput, TOutput> {
    return this._task.s(data);
  }

  /**
   * Dispatch one job per item in parallel. Sugar for
   * `group(...items.map(i => this.s(i)))`. Returns a {@link WorkflowHandle}
   * that resolves when all jobs complete.
   */
  map(items: TInput[]): WorkflowHandle<TOutput[]> {
    return this._task.map(items);
  }

  /**
   * Split items into chunks. Each chunk runs in parallel; chunks run
   * sequentially. Useful for rate-limited batch processing.
   */
  chunk(items: TInput[], options: { size: number }): WorkflowHandle<TOutput[]> {
    return this._task.chunk(items, options);
  }
}
