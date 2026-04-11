import { Inject } from "@nestjs/common";
import type { TaskContract } from "taskora";
import { getTaskToken } from "../tokens.js";

/**
 * Escape-hatch decorator that injects a per-contract {@link BoundTask}
 * provider created by `TaskoraModule.forFeature([...contracts])`.
 *
 * **Prefer `TaskoraRef.for(contract)` for new code** — it keeps full
 * type-safety (generic method, no manual annotation) and does not require
 * listing every contract in `forFeature`. `@InjectTask` exists for callers
 * who prefer property-level injection, but because TypeScript parameter
 * decorators cannot propagate generics into the property type, you'll
 * need to annotate `BoundTask<Input, Output>` manually — and risk drift
 * if the contract's schema changes later.
 *
 * ```ts
 * // Preferred:
 * constructor(private tasks: TaskoraRef) {}
 * async send(u: User) {
 *   await this.tasks.for(sendEmailTask).dispatch({ to: u.email })
 * }
 *
 * // Escape hatch:
 * constructor(@InjectTask(sendEmailTask) private sendEmail: BoundTask<Input, Output>) {}
 * ```
 */
export const InjectTask = (
  contract: TaskContract<any, any>,
  appName?: string,
): ParameterDecorator => Inject(getTaskToken(contract, appName));
