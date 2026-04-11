import { Inject } from "@nestjs/common";
import { getAppToken } from "../tokens.js";

/**
 * Inject a taskora {@link App} instance. Pass the same `name` that was given
 * to {@link TaskoraModule.forRoot} for multi-app setups; omit it to resolve
 * the default slot.
 *
 * ```ts
 * class EmailService {
 *   constructor(@InjectApp() private readonly app: App) {}
 * }
 * ```
 *
 * For producing typed dispatchers prefer `TaskoraRef.for(contract)` over
 * raw `App.register()` — see the Phase 2 `@InjectTask` / `TaskoraRef` API.
 */
export const InjectApp = (name?: string): ParameterDecorator => Inject(getAppToken(name));
