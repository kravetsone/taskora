# Middleware

taskora has a Koa-style onion middleware model — each middleware receives the `MiddlewareContext` and a `next()` function, runs work before/after `next()`, and is composed into a chain applied around the handler. `@taskora/nestjs` lets you write that chain as **DI-managed classes**, so middleware can inject any provider it needs (loggers, tracers, metrics, config) without any global state.

## The interface

```ts
import type { Taskora } from "taskora"

export interface TaskoraMiddleware {
  use(
    ctx: Taskora.MiddlewareContext,
    next: () => Promise<void>,
  ): Promise<void> | void
}
```

`ctx` extends the per-job `Context` with `task: { name }`, mutable `data`, and (after `next()` resolves) mutable `result`. You can:

- **Read or mutate `ctx.data`** before calling `next()` — e.g. to inject correlation IDs, decrypt a payload.
- **Read or mutate `ctx.result`** after `next()` returns — e.g. to scrub PII before it's persisted.
- **Wrap the call in `try/catch`** to centralise error handling or metric timing.
- **Skip `next()`** to short-circuit — the handler never runs and `ctx.result` stays `undefined`.
- **Use `ctx.log`, `ctx.progress`, `ctx.signal`** exactly like inside the handler.

## Writing a middleware class

```ts
// src/common/middleware/logging.middleware.ts
import { Logger } from "@nestjs/common"
import { TaskMiddleware, type TaskoraMiddleware } from "@taskora/nestjs"
import type { Taskora } from "taskora"

@TaskMiddleware()
export class LoggingMiddleware implements TaskoraMiddleware {
  private readonly logger = new Logger("Taskora")

  async use(ctx: Taskora.MiddlewareContext, next: () => Promise<void>) {
    const start = Date.now()
    this.logger.log(`→ ${ctx.task.name} attempt=${ctx.attempt}`)
    try {
      await next()
      this.logger.log(`✓ ${ctx.task.name} (${Date.now() - start}ms)`)
    } catch (err) {
      this.logger.error(`✗ ${ctx.task.name} (${Date.now() - start}ms)`, err as Error)
      throw err
    }
  }
}
```

`@TaskMiddleware()` is an alias for `@Injectable()` — it's optional but makes the intent explicit at the top of the file. Any class that implements the `use(ctx, next)` shape and is a Nest provider works.

## Wiring with `forRoot`

Pass the class to `TaskoraModule.forRoot({ middleware })` and register it as a provider in the owning module:

```ts
import { Module } from "@nestjs/common"
import { TaskoraModule } from "@taskora/nestjs"
import { LoggingMiddleware } from "./common/middleware/logging.middleware"

@Module({
  imports: [
    TaskoraModule.forRoot({
      adapter: redisAdapter({ client: new Redis(process.env.REDIS_URL!) }),
      middleware: [LoggingMiddleware],   // ← references the class
    }),
  ],
  providers: [LoggingMiddleware],        // ← ALSO must be in providers so Nest instantiates it
})
export class AppModule {}
```

The `TaskoraExplorer` walks the DI graph on bootstrap, finds the middleware instance by class reference, and calls `app.use((ctx, next) => instance.use(ctx, next))`. The closure captures the DI-managed instance, so every field and injected dependency stays live across jobs.

**If you forget to add the class to `providers`**, the explorer throws a clear error at init:

```
TaskoraModule middleware LoggingMiddleware was listed in forRoot({ middleware }) but
no DI instance was found. Make sure it is included in the owning module's providers:
[LoggingMiddleware] array.
```

## Composition order

`middleware: [Outer, Middle, Inner]` registers them in list order with `app.use()`, which means the first entry is **outermost** — it wraps the others. The composed chain runs like this for a single job:

```
Outer.use()   → before next()
  Middle.use() → before next()
    Inner.use() → before next()
      <handler runs>
    Inner.use() → after next()
  Middle.use() → after next()
Outer.use()   → after next()
```

If you need one middleware to see the result of another (e.g. a metrics middleware that needs to know whether a logging middleware set a correlation ID), order them explicitly.

## Multiple middleware classes with shared dependencies

DI means all middleware classes resolve from the same container, so they can share singletons:

```ts
@Injectable()
export class CorrelationService {
  generate(): string {
    return randomUUID()
  }
}

@TaskMiddleware()
export class CorrelationMiddleware implements TaskoraMiddleware {
  constructor(private readonly correlation: CorrelationService) {}

  async use(ctx: Taskora.MiddlewareContext, next: () => Promise<void>) {
    (ctx as any).correlationId = this.correlation.generate()
    await next()
  }
}

@TaskMiddleware()
export class TracingMiddleware implements TaskoraMiddleware {
  constructor(
    private readonly tracer: TracerService,
    private readonly correlation: CorrelationService,  // same singleton
  ) {}

  async use(ctx: Taskora.MiddlewareContext, next: () => Promise<void>) {
    const span = this.tracer.startSpan(ctx.task.name, {
      attributes: { correlationId: (ctx as any).correlationId },
    })
    try {
      await next()
      span.end()
    } catch (err) {
      span.recordException(err as Error)
      span.end()
      throw err
    }
  }
}
```

Register both as providers and list them in order:

```ts
TaskoraModule.forRoot({
  adapter: …,
  middleware: [CorrelationMiddleware, TracingMiddleware],  // correlation wraps tracing
})

// providers array:
providers: [
  CorrelationService,
  TracerService,
  CorrelationMiddleware,
  TracingMiddleware,
]
```

## Inline function middleware still works

If you don't need DI, taskora's native `app.use(fn)` still works. Grab the App via `@InjectApp` and call it from a startup hook:

```ts
import { Injectable, OnApplicationBootstrap } from "@nestjs/common"
import { InjectApp } from "@taskora/nestjs"
import type { App } from "taskora"

@Injectable()
export class InlineMiddlewareInstaller implements OnApplicationBootstrap {
  constructor(@InjectApp() private readonly app: App) {}

  onApplicationBootstrap() {
    this.app.use(async (ctx, next) => {
      console.log("inline before", ctx.task.name)
      await next()
      console.log("inline after", ctx.task.name)
    })
  }
}
```

Usually not worth it — if you're going through the `@InjectApp` dance to register middleware, you'd rather have a `@TaskMiddleware` class. But the escape hatch is there.

## Common patterns

### Timing / metrics

Already shown above in `LoggingMiddleware`. The standard pattern: record `Date.now()` before `next()`, subtract after, push to your histogram service.

### Correlation / request ID propagation

Use the example above — a `CorrelationMiddleware` that stamps a value on `ctx` before `next()`. Handlers can read it via `ctx.data`-adjacent fields if you extend the type.

### Auth / authorization for jobs

If a job payload carries a tenant ID or user context, validate it in middleware before `next()`:

```ts
@TaskMiddleware()
export class TenantGuardMiddleware implements TaskoraMiddleware {
  constructor(private readonly tenants: TenantService) {}

  async use(ctx: Taskora.MiddlewareContext, next: () => Promise<void>) {
    const tenantId = (ctx.data as { tenantId?: string }).tenantId
    if (!tenantId) throw new Error("job missing tenantId")

    const tenant = await this.tenants.findActive(tenantId)
    if (!tenant) throw new Error(`tenant ${tenantId} is inactive`)

    await next()
  }
}
```

### Result scrubbing

Mutate `ctx.result` after `next()` to strip PII before taskora persists it:

```ts
@TaskMiddleware()
export class PiiScrubberMiddleware implements TaskoraMiddleware {
  async use(ctx: Taskora.MiddlewareContext, next: () => Promise<void>) {
    await next()
    if (ctx.result && typeof ctx.result === "object") {
      ctx.result = redact(ctx.result as Record<string, unknown>, ["email", "phone"])
    }
  }
}
```

## Per-consumer middleware

The current release wires middleware at the **app level** — every task runs through the same chain. Per-consumer middleware (e.g. `@TaskConsumer(contract, { middleware: [SomeMw] })`) is planned for a future phase.

Until then, the workaround is to gate logic inside a global middleware by `ctx.task.name`:

```ts
async use(ctx: Taskora.MiddlewareContext, next: () => Promise<void>) {
  if (ctx.task.name === "send-email") {
    // email-specific setup
  }
  await next()
}
```

## Multi-app middleware

`TaskoraModule.forRoot({ name: 'secondary', middleware: [...] })` binds the listed middleware to that named app. Default-app and secondary-app middleware chains are fully independent.

```ts
@Module({
  imports: [
    TaskoraModule.forRoot({
      adapter: primaryAdapter,
      middleware: [CorrelationMiddleware, LoggingMiddleware],
    }),
    TaskoraModule.forRoot({
      name: "background",
      adapter: backgroundAdapter,
      middleware: [TracingMiddleware],   // different chain for the background app
    }),
  ],
  providers: [CorrelationMiddleware, LoggingMiddleware, TracingMiddleware],
})
export class AppModule {}
```

Same DI instances are reusable — `CorrelationMiddleware` is a singleton regardless of how many named apps reference it.
