import { Inject } from "@nestjs/common";
import { Inspector } from "taskora";
import { DEFAULT_APP_NAME, getInspectorToken } from "../tokens.js";

/**
 * Inject a taskora {@link Inspector} bound to a specific named app.
 * Default slot resolves via the `Inspector` class token, so you can
 * write `constructor(private inspector: Inspector)` with no decorator
 * for single-app setups.
 *
 * ```ts
 * constructor(private inspector: Inspector) {}
 * // or, for a named app:
 * constructor(@InjectInspector('secondary') private inspector: Inspector) {}
 * ```
 */
export const InjectInspector = (name?: string): ParameterDecorator => {
  if (!name || name === DEFAULT_APP_NAME) return Inject(Inspector);
  return Inject(getInspectorToken(name));
};
