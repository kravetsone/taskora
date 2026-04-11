import { Injectable } from "@nestjs/common";

/**
 * Class-level marker that applies `@Injectable()` so Nest's DI picks
 * up the middleware, and flags it for human readers / future
 * reflection-based features. Using this decorator is optional — any
 * class that implements {@link TaskoraMiddleware} and is listed under
 * `TaskoraModule.forRoot({ middleware: [...] })` works regardless.
 *
 * ```ts
 * @TaskMiddleware()
 * export class LoggingMiddleware implements TaskoraMiddleware {
 *   async use(ctx, next) { … }
 * }
 * ```
 */
export const TaskMiddleware = (): ClassDecorator => {
  return (target: object) => {
    Injectable()(target as (...args: any[]) => any);
  };
};
