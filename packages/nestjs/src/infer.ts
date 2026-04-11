import type { BoundTask, InferInput, InferOutput } from "taskora";

/**
 * Convenience alias for `BoundTask<InferInput<C>, InferOutput<C>>`.
 *
 * Collapses the duplication users would otherwise hit on the
 * `@InjectTask` escape hatch path — TypeScript parameter decorators
 * can't propagate generics into the property type, so without a
 * helper callers would have to write:
 *
 * ```ts
 * @InjectTask(sendEmailTask)
 * private sendEmail: BoundTask<InferInput<typeof sendEmailTask>, InferOutput<typeof sendEmailTask>>
 * ```
 *
 * With `InferBoundTask` it collapses to one name that tracks the
 * contract automatically — rename or reshape `sendEmailTask` and
 * every `@InjectTask` site updates with a single `typeof`:
 *
 * ```ts
 * @InjectTask(sendEmailTask)
 * private sendEmail: InferBoundTask<typeof sendEmailTask>
 * ```
 *
 * For new code, `TaskoraRef.for(contract)` is still the preferred
 * path — generic methods propagate types natively and you don't
 * need a helper at all. `InferBoundTask` is for property-decorator
 * fans who want the same drift-proofing TaskoraRef already gives.
 */
export type InferBoundTask<C> = BoundTask<InferInput<C>, InferOutput<C>>;
