import type { Taskora } from "./types.js";

/**
 * Koa-style compose: creates a single function from an array of middleware.
 * Execution follows the onion model — each middleware calls `next()` to
 * proceed deeper, then resumes after `await next()` returns.
 */
export function compose(
  middlewares: Taskora.Middleware[],
): (ctx: Taskora.MiddlewareContext) => Promise<void> {
  return function composed(ctx: Taskora.MiddlewareContext): Promise<void> {
    let index = -1;

    function dispatch(i: number): Promise<void> {
      if (i <= index) {
        return Promise.reject(new Error("next() called multiple times"));
      }
      index = i;
      if (i >= middlewares.length) return Promise.resolve();
      return Promise.resolve(middlewares[i](ctx, () => dispatch(i + 1)));
    }

    return dispatch(0);
  };
}
