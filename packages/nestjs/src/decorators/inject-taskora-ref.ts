import { Inject } from "@nestjs/common";
import { TaskoraRef } from "../taskora-ref.js";
import { DEFAULT_APP_NAME, getTaskoraRefToken } from "../tokens.js";

/**
 * Inject a {@link TaskoraRef} bound to a specific named {@link App}. Omit
 * `name` or pass the default slot to fall back on the `TaskoraRef` class
 * token — in that case prefer the zero-decorator form:
 *
 * ```ts
 * constructor(private tasks: TaskoraRef) {}
 * ```
 *
 * Only reach for `@InjectTaskoraRef('secondary')` when you have more than
 * one app registered via `TaskoraModule.forRoot({ name: '...' })`.
 */
export const InjectTaskoraRef = (name?: string): ParameterDecorator => {
  if (!name || name === DEFAULT_APP_NAME) return Inject(TaskoraRef);
  return Inject(getTaskoraRefToken(name));
};
