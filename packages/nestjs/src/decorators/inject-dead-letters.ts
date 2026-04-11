import { Inject } from "@nestjs/common";
import { DeadLetterManager } from "taskora";
import { DEFAULT_APP_NAME, getDeadLettersToken } from "../tokens.js";

/**
 * Inject a taskora {@link DeadLetterManager} bound to a specific
 * named app. Default slot resolves via the `DeadLetterManager` class
 * token — zero-decorator form works for single-app setups:
 *
 * ```ts
 * constructor(private dlq: DeadLetterManager) {}
 * // for a named app:
 * constructor(@InjectDeadLetters('secondary') private dlq: DeadLetterManager) {}
 * ```
 */
export const InjectDeadLetters = (name?: string): ParameterDecorator => {
  if (!name || name === DEFAULT_APP_NAME) return Inject(DeadLetterManager);
  return Inject(getDeadLettersToken(name));
};
