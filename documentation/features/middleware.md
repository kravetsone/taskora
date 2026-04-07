# Middleware

Taskora uses a Koa-style **onion model** for middleware. Middleware wraps your handler — it can intercept data on the way in and results on the way out.

<MiddlewarePipelineVisualizer />

## App-Level Middleware

Applied to **all tasks** in the app.

```ts
taskora.use(async (ctx, next) => {
  const start = Date.now()
  await next()
  console.log(`${ctx.task.name} took ${Date.now() - start}ms`)
})
```

Multiple `taskora.use()` calls chain in order. Must be called **before** `taskora.start()`.

## Per-Task Middleware

Applied to a specific task only.

```ts
taskora.task("process-payment", {
  middleware: [authMiddleware, validateMiddleware],
  handler: async (data, ctx) => { /* ... */ },
})
```

## Execution Order

```
taskora.use(mw1)  ──→  taskora.use(mw2)  ──→  task middleware  ──→  handler
     │                   │                    │                 │
     │  before next()    │  before next()     │  before next()  │  runs
     │                   │                    │                 │
     │  after next()     │  after next()      │  after next()   │  returns
     ←──────────────────←──────────────────←──────────────────←
```

## Middleware Context

Middleware receives a `MiddlewareContext` that extends `Context` with:

```ts
interface MiddlewareContext extends Context {
  task: { name: string }   // which task is running
  data: unknown            // mutable — transform input before handler
  result: unknown          // readable after next() — transform output
}
```

### Mutating Data

```ts
taskora.use(async (ctx, next) => {
  // Transform input before handler
  ctx.data = { ...ctx.data, processedAt: Date.now() }
  await next()
})
```

### Reading/Modifying Results

```ts
taskora.use(async (ctx, next) => {
  await next()
  // Wrap result after handler
  ctx.result = { data: ctx.result, meta: { processedBy: "v2" } }
})
```

### Error Handling

```ts
taskora.use(async (ctx, next) => {
  try {
    await next()
  } catch (err) {
    ctx.log.error("Task failed", { error: err.message })
    throw err // re-throw to propagate
  }
})
```

## Practical Examples

### Logging Middleware

```ts
taskora.use(async (ctx, next) => {
  ctx.log.info(`Starting ${ctx.task.name}`, { attempt: ctx.attempt })
  const start = Date.now()
  try {
    await next()
    ctx.log.info(`Completed in ${Date.now() - start}ms`)
  } catch (err) {
    ctx.log.error(`Failed after ${Date.now() - start}ms`, { error: err.message })
    throw err
  }
})
```

### Metrics Middleware

```ts
taskora.use(async (ctx, next) => {
  const timer = metrics.startTimer({ task: ctx.task.name })
  try {
    await next()
    metrics.increment("task.success", { task: ctx.task.name })
  } catch (err) {
    metrics.increment("task.failure", { task: ctx.task.name })
    throw err
  } finally {
    timer.end()
  }
})
```

## Composition

Middleware is composed once at worker construction time (not per job) using the internal `compose()` function. The pipeline is: `deserialize → migrate → validate → [middleware chain → handler]`.
