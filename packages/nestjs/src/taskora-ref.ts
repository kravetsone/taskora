import type { App, BoundTask, TaskContract } from "taskora";

/**
 * Injectable façade over a taskora {@link App} that preserves full
 * type-safety when turning a {@link TaskContract} into a dispatchable
 * {@link BoundTask}.
 *
 * Inject it anywhere you'd otherwise reach for `app.register(contract)`:
 *
 * ```ts
 * @Injectable()
 * export class EmailService {
 *   constructor(private tasks: TaskoraRef) {}
 *
 *   async notifySignup(user: User) {
 *     await this.tasks.for(sendEmailTask).dispatch({ to: user.email })
 *   }
 * }
 * ```
 *
 * `.for()` is cheap — `app.register()` is idempotent by task name, so
 * repeat calls just hand back the same bound task via an internal `Map`
 * lookup. Feel free to call it once per method or cache it in a getter,
 * whichever reads better.
 *
 * For multi-app setups, use `@InjectTaskoraRef('secondary')` to pull the
 * `TaskoraRef` bound to the named `App`.
 */
export class TaskoraRef {
  constructor(private readonly app: App) {}

  /**
   * Resolve a {@link TaskContract} to its dispatchable {@link BoundTask}.
   * Fully generic — the returned value's `dispatch` input/output types
   * are inferred from the contract with no manual annotation.
   */
  for<TInput, TOutput>(contract: TaskContract<TInput, TOutput>): BoundTask<TInput, TOutput> {
    return this.app.register(contract);
  }

  /**
   * Escape hatch for callers that need the underlying {@link App}. Prefer
   * `@InjectApp()` at the constructor when you really want the raw app —
   * this getter exists so `TaskoraRef` remains a complete entry point and
   * callers don't have to inject two things just to reach inspector / dlq
   * / schedules.
   */
  get raw(): App {
    return this.app;
  }
}
