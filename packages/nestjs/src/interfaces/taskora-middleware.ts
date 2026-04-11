import type { Taskora } from "taskora";

/**
 * Interface for DI-managed class middleware. Implement this on any
 * Nest provider and pass the class reference to
 * `TaskoraModule.forRoot({ middleware: [MyMiddleware] })` (or decorate
 * it with `@TaskMiddleware()` for convenience).
 *
 * The `use()` method is called by taskora's Koa-style onion chain
 * — call `await next()` to continue the pipeline, skip it to
 * short-circuit. Read `ctx.data`, mutate it, or inspect `ctx.result`
 * after `next()` resolves. Full MiddlewareContext shape is in
 * `Taskora.MiddlewareContext`.
 *
 * ```ts
 * @TaskMiddleware()
 * export class LoggingMiddleware implements TaskoraMiddleware {
 *   constructor(private logger: LoggerService) {}
 *
 *   async use(ctx: Taskora.MiddlewareContext, next: () => Promise<void>) {
 *     const start = Date.now()
 *     await next()
 *     this.logger.log(`${ctx.task.name} in ${Date.now() - start}ms`)
 *   }
 * }
 * ```
 */
export interface TaskoraMiddleware {
  use(ctx: Taskora.MiddlewareContext, next: () => Promise<void>): Promise<void> | void;
}
