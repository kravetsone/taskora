---
name: taskora-nestjs
description: >
  @taskora/nestjs — first-class NestJS integration for taskora. Use when
  building task queues in a Nest backend: TaskoraModule.forRoot,
  @TaskConsumer classes with constructor DI, @OnTaskEvent method
  bindings, TaskoraRef.for() zero-decorator dispatching, class
  middleware via @TaskMiddleware, @InjectInspector / @InjectDeadLetters
  / @InjectSchedules observability accessors, TaskoraBoardModule for
  the admin UI mount, producer/worker split deployment, multi-app
  routing, and the TaskoraTestHarness end-to-end test helper. Not for
  @nestjs/bull, @bull-board/nestjs, or bullmq-nestjs — those are
  different libraries with different APIs.
metadata:
  author: Taskora
  version: "0.1.0"
  source: https://github.com/kravetsone/taskora
---

# @taskora/nestjs — NestJS Integration for taskora

First-class Nest integration. Everything taskora exposes (dispatching, handlers, events, middleware, inspector, DLQ, schedules, admin dashboard, testing) is injectable through Nest's DI graph. Constructor injection just works — including for `@TaskConsumer` classes that run as workers.

## When to use

- Building a task queue inside an existing NestJS backend
- Want DI-managed `@TaskConsumer` classes instead of bare handler functions
- Need class-based middleware with injectable dependencies (loggers, tracers)
- Need `@InjectInspector` / `@InjectDeadLetters` / `@InjectSchedules` to build custom admin endpoints
- Splitting producer/worker into separate Nest processes with shared contracts
- Unit-testing Nest modules that dispatch to the queue without Redis/Docker

**Do NOT** use this skill for `@nestjs/bull`, `@bull-board/nestjs`, or any bullmq-based integration — those are different libraries with different APIs.

## Installation

```bash
npm install @taskora/nestjs taskora reflect-metadata
npm install taskora ioredis        # for the Redis adapter
npm install @taskora/board hono @hono/node-server  # optional: admin dashboard
```

`main.ts` **must** import `reflect-metadata` as the first line — above every other import — or Nest's constructor DI silently injects undefined:

```ts
import "reflect-metadata"
import { NestFactory } from "@nestjs/core"
// ...
```

`tsconfig.json` needs:

```jsonc
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

## Module registration

Single app:

```ts
import { Module } from "@nestjs/common"
import { TaskoraModule } from "@taskora/nestjs"
import { redisAdapter } from "taskora/redis"
import { Redis } from "ioredis"

@Module({
  imports: [
    TaskoraModule.forRoot({
      adapter: redisAdapter({ client: new Redis(process.env.REDIS_URL!) }),
      defaults: {
        retry: { attempts: 3, backoff: "exponential" },
        timeout: 30_000,
      },
    }),
  ],
})
export class AppModule {}
```

Async (ConfigService pattern):

```ts
import { ConfigModule, ConfigService } from "@nestjs/config"

TaskoraModule.forRootAsync({
  imports: [ConfigModule],
  useFactory: (cfg: ConfigService) => ({
    adapter: redisAdapter({
      client: new Redis(cfg.getOrThrow("REDIS_URL")),
    }),
  }),
  inject: [ConfigService],
})
```

`TaskoraCoreModule` is `@Global`, so providers in any feature module can inject `TaskoraRef`, `Inspector`, `DeadLetterManager`, etc. without re-importing `TaskoraModule`.

### Options

`TaskoraModule.forRoot(options)` accepts everything taskora's `createTaskora()` takes plus four Nest-specific fields:

- `name?: string` — named slot for multi-app setups (default: `"default"`)
- `autoStart?: boolean` — whether `app.start()` runs on `onApplicationBootstrap` (default: `true`; set to `false` for producer-only processes)
- `middleware?: Type<TaskoraMiddleware>[]` — class middleware resolved via DI
- Everything else (`adapter`, `defaults`, `retention`, `stall`, `scheduler`, `serializer`, `validateOnDispatch`) passes through to taskora unchanged

## Recommended file layout

```
src/
├── main.ts
├── app.module.ts
├── tasks/                         ← all contracts live here
│   ├── index.ts                   ← barrel: `export * from './email.contracts'`
│   └── email.contracts.ts
├── email/
│   ├── email.module.ts
│   ├── email.service.ts           ← PRODUCER — dispatches via TaskoraRef
│   ├── email.consumer.ts          ← CONSUMER — @TaskConsumer class
│   └── mailer.service.ts          ← DI dependency of the consumer
└── common/
    └── middleware/
        └── logging.middleware.ts
```

**Rules:**

- **Contracts go in `src/tasks/`**, not in feature folders. Even in a monolith, services dispatch tasks they don't own — keeping contracts central avoids cross-folder imports.
- **Consumers live next to their dependencies** in the feature module. A feature module's `providers: []` array is the full registration surface.
- **Dispatchers go in service classes**, not controllers. Controllers call `userService.onSignup()` which internally dispatches — same layering as SQL calls.
- **`TaskoraModule.forRoot` only in `AppModule`** — `@Global` handles the rest. Feature modules that need per-contract DI tokens use `TaskoraModule.forFeature([...])`, but most of the time `TaskoraRef.for(contract)` removes that need.
- **Don't register a consumer in the same module as the service that dispatches its contract** — they're structurally independent. `BillingModule` can dispatch `sendEmailTask` via `TaskoraRef` without importing anything from `EmailModule`.

## Contracts

Always use `defineTask` from `taskora` to declare contracts. The contract is the shared surface between producer and consumer — even if they're in the same process today, you want the option to split tomorrow.

```ts
// src/tasks/email.contracts.ts
import { defineTask } from "taskora"
import { z } from "zod"

export const sendEmailTask = defineTask({
  name: "send-email",
  input: z.object({
    to: z.string().email(),
    subject: z.string(),
    body: z.string().optional(),
  }),
  output: z.object({
    messageId: z.string(),
  }),
  retry: { attempts: 5, backoff: "exponential" },
  timeout: "30s",
})
```

```ts
// src/tasks/index.ts
export * from "./email.contracts"
export * from "./image.contracts"
// ...
```

Producers and consumers both import from `@/tasks` — they only share the contract, never the handler.

## Dispatching — TaskoraRef.for() (primary path)

Zero-decorator, zero-annotation DI. This is the default path — use it unless you have a concrete reason not to.

```ts
import { Injectable } from "@nestjs/common"
import { TaskoraRef } from "@taskora/nestjs"
import { sendEmailTask } from "@/tasks"

@Injectable()
export class EmailService {
  constructor(private readonly tasks: TaskoraRef) {}

  async notifySignup(user: { email: string; name: string }) {
    const handle = this.tasks.for(sendEmailTask).dispatch({
      to: user.email,
      subject: `Welcome, ${user.name}`,
    })
    const { messageId } = await handle.result
    return messageId
  }
}
```

- `TaskoraRef` is **auto-provided** by `TaskoraModule.forRoot` — inject it anywhere, no decorator required.
- `.for()` is a generic method: `for<I, O>(contract: TaskContract<I, O>): BoundTask<I, O>`. TypeScript propagates the contract's input/output types to `.dispatch()` and `handle.result` with zero annotations.
- `.for()` is cheap — `app.register(contract)` is idempotent, backed by a Map lookup. Call it inline in every method or cache in a getter, same cost either way.

## Dispatching — @InjectTask escape hatch

If you prefer property-style injection, use `@InjectTask` + `InferBoundTask<typeof contract>`:

```ts
import { Injectable } from "@nestjs/common"
import { InjectTask, type InferBoundTask, TaskoraModule } from "@taskora/nestjs"
import { sendEmailTask } from "@/tasks"

@Injectable()
export class EmailService {
  constructor(
    @InjectTask(sendEmailTask)
    private readonly sendEmail: InferBoundTask<typeof sendEmailTask>,
  ) {}

  async notifySignup(user: User) {
    await this.sendEmail.dispatch({ to: user.email, subject: "Welcome" })
  }
}
```

**Requires `forFeature`** — the per-contract DI token only exists if you register it:

```ts
@Module({
  imports: [TaskoraModule.forFeature([sendEmailTask, processImageTask])],
  providers: [EmailService],
})
export class EmailModule {}
```

**Why `InferBoundTask<typeof contract>` and NOT `BoundTask<I, O>`:** TypeScript parameter decorators cannot propagate generics into the decorated property's type, so without the helper you'd have to manually spell `BoundTask<{to: string}, {messageId: string}>` and it drifts every time the schema changes. `InferBoundTask<typeof contract>` reads the types directly from the contract value — rename a field and it tracks.

For new code, prefer `TaskoraRef.for()`. `@InjectTask` is an escape hatch for callers who want property-level injection.

## Consumers — @TaskConsumer

Mark any Nest provider as a worker handler for a specific contract. Full constructor DI.

```ts
import { TaskConsumer, OnTaskEvent } from "@taskora/nestjs"
import type { InferInput, InferOutput, Taskora } from "taskora"
import { MailerService } from "./mailer.service"
import { sendEmailTask } from "@/tasks"

@TaskConsumer(sendEmailTask, {
  concurrency: 10,
  timeout: "30s",
  retry: { attempts: 5, backoff: "exponential" },
})
export class SendEmailConsumer {
  constructor(private readonly mailer: MailerService) {}

  async process(
    data: InferInput<typeof sendEmailTask>,
    ctx: Taskora.Context,
  ): Promise<InferOutput<typeof sendEmailTask>> {
    ctx.log.info("sending", { to: data.to })
    return this.mailer.send(data)
  }

  @OnTaskEvent("completed")
  onDone(evt: Taskora.TaskEventMap<InferOutput<typeof sendEmailTask>>["completed"]) {
    // metrics, logs — DI deps are live here
  }

  @OnTaskEvent("failed")
  onFail(evt: Taskora.TaskEventMap<never>["failed"]) {
    // alerts, dead-letter analysis
  }
}
```

Register as a normal provider:

```ts
@Module({
  providers: [SendEmailConsumer, MailerService],
})
export class EmailModule {}
```

**The process() method is the handler.** It receives the deserialized+validated input and taskora's `Context`. Throwing goes through taskora's retry machinery automatically. The consumer instance is a **singleton** — the same DI-managed instance handles every job, injected dependencies stay live across runs.

### @TaskConsumer options

Accepts a subset of `ImplementOptions`:

```ts
interface TaskConsumerOptions {
  app?: string                  // multi-app routing — default: DEFAULT_APP_NAME
  concurrency?: number
  timeout?: number | Duration
  retry?: Taskora.RetryConfig
  stall?: Taskora.StallConfig
  singleton?: boolean
  concurrencyLimit?: number
  ttl?: Taskora.TtlConfig
  version?: number              // payload version
  since?: number                // oldest supported version
}
```

### @OnTaskEvent

Method-level binding to per-task events (`completed`, `failed`, `retrying`, `progress`, `active`, `stalled`, `cancelled`). The method runs on the same consumer instance as `process()`, with DI dependencies intact.

For cross-task / app-level events (`worker:ready`, `worker:error`), inject the raw App and use `.on()`:

```ts
import { InjectApp } from "@taskora/nestjs"
import type { App } from "taskora"

@Injectable()
export class WorkerHealthService implements OnModuleInit {
  constructor(@InjectApp() private readonly app: App) {}

  onModuleInit() {
    this.app.on("worker:ready", () => { /* ... */ })
  }
}
```

### Lifecycle

`TaskoraExplorer` runs the discovery pass inside `onApplicationBootstrap`:

1. Walk `DiscoveryService.getProviders()` → find every `@TaskConsumer`.
2. Filter by `options.app` matching this explorer's app name.
3. Call `app.implement(contract, handler)` where `handler` is a closure over the DI instance's `process` method.
4. Wire every `@OnTaskEvent` method via `task.on(event, boundHandler)`.
5. Call `app.start()` unless `autoStart: false`.

**All handlers are attached BEFORE the worker starts** — no race where a worker picks up a job for an unimplemented contract.

On `onApplicationShutdown` the explorer awaits `app.close()`. Call `app.enableShutdownHooks()` in `main.ts` so SIGTERM triggers the drain.

## Class middleware

Taskora's middleware is a Koa-style onion chain. `@taskora/nestjs` lets you write each middleware as a DI-managed class.

```ts
import { TaskMiddleware, type TaskoraMiddleware } from "@taskora/nestjs"
import { Logger } from "@nestjs/common"
import type { Taskora } from "taskora"

@TaskMiddleware()
export class LoggingMiddleware implements TaskoraMiddleware {
  private readonly logger = new Logger("Taskora")

  async use(ctx: Taskora.MiddlewareContext, next: () => Promise<void>) {
    const start = Date.now()
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

Wire it in `forRoot` **and** register as a provider:

```ts
@Module({
  imports: [
    TaskoraModule.forRoot({
      adapter: …,
      middleware: [LoggingMiddleware],      // ← reference the class
    }),
  ],
  providers: [LoggingMiddleware],           // ← MUST also be in providers
})
export class AppModule {}
```

If you forget the `providers` entry, the explorer throws at init with a clear error.

Composition order: list order is **outermost to innermost**. `middleware: [A, B, C]` → A wraps B wraps C wraps the handler.

Multiple middlewares can share DI singletons (all resolve from the same container).

## Observability — Inspector, DeadLetters, Schedules

All three are injectable per app.

### Inspector (default slot — zero decorator)

```ts
import { Injectable } from "@nestjs/common"
import { Inspector } from "taskora"

@Injectable()
export class QueueStatsService {
  constructor(private readonly inspector: Inspector) {}

  async dashboardSnapshot() {
    const stats = await this.inspector.stats()
    const recentlyFailed = await this.inspector.failed({ limit: 20 })
    return { stats, recentlyFailed }
  }

  async findJob(jobId: string) {
    return this.inspector.find(jobId)        // cross-task search
  }
}
```

### DeadLetterManager (default slot — zero decorator)

```ts
import { Injectable } from "@nestjs/common"
import { DeadLetterManager } from "taskora"

@Injectable()
export class DlqService {
  constructor(private readonly dlq: DeadLetterManager) {}

  async retry(jobId: string) {
    return this.dlq.retry(jobId)
  }

  async retryAllForTask(task: string) {
    return this.dlq.retryAll({ task })
  }
}
```

### Schedules (always via decorator — ScheduleManager not in taskora's public exports)

```ts
import { Injectable } from "@nestjs/common"
import { InjectSchedules } from "@taskora/nestjs"
import type { App } from "taskora"

@Injectable()
export class SchedulesService {
  constructor(@InjectSchedules() private readonly schedules: App["schedules"]) {}

  async listAll() {
    return this.schedules.list()
  }

  async pause(name: string) {
    return this.schedules.pause(name)
  }

  async trigger(name: string) {
    return this.schedules.trigger(name)
  }
}
```

Type annotation uses `App["schedules"]` because `ScheduleManager` isn't in taskora's public class exports.

### Multi-app accessors

```ts
import {
  InjectDeadLetters,
  InjectInspector,
  InjectSchedules,
} from "@taskora/nestjs"
import { DeadLetterManager, Inspector } from "taskora"
import type { App } from "taskora"

@Injectable()
class AdminService {
  constructor(
    // Default app — class tokens, no decorator
    readonly primaryInspector: Inspector,
    readonly primaryDlq: DeadLetterManager,
    @InjectSchedules() readonly primarySchedules: App["schedules"],

    // Named "secondary" app — string tokens via decorators
    @InjectInspector("secondary") readonly secondaryInspector: Inspector,
    @InjectDeadLetters("secondary") readonly secondaryDlq: DeadLetterManager,
    @InjectSchedules("secondary") readonly secondarySchedules: App["schedules"],
  ) {}
}
```

Only the default slot uses class tokens — one forRoot without a `name` can own them. Every named slot uses string-token decorators.

## Admin dashboard — TaskoraBoardModule

`@taskora/board` is an optional peer dep. Install it only when you want the dashboard. `TaskoraBoardModule.forRoot` dynamically imports it inside an async factory, so unused → zero cost.

### Register

```ts
import { TaskoraBoardModule, TaskoraModule } from "@taskora/nestjs"

@Module({
  imports: [
    TaskoraModule.forRoot({ adapter: … }),
    TaskoraBoardModule.forRoot({
      basePath: "/board",
      readOnly: process.env.NODE_ENV !== "production",
      auth: {
        cookiePassword: process.env.BOARD_COOKIE_PASSWORD!,  // 32+ chars
        authenticate: async ({ username, password }) => {
          return await this.validateAdmin(username, password)
        },
      },
    }),
  ],
})
export class AppModule {}
```

### Mount in main.ts

The board is a Hono app, NOT an Express router. Mount it explicitly in `main.ts` using `@hono/node-server`:

```ts
// src/main.ts
import "reflect-metadata"
import { NestFactory } from "@nestjs/core"
import { getRequestListener } from "@hono/node-server"
import type { Board } from "@taskora/board"
import { getBoardToken } from "@taskora/nestjs"
import { AppModule } from "./app.module"

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.enableShutdownHooks()

  const board = app.get<Board>(getBoardToken())
  app.use("/board", getRequestListener(board.fetch))

  await app.listen(3000)
}
bootstrap()
```

Three lines to wire. The `Board` type comes from `@taskora/board`, not from `@taskora/nestjs` — `@taskora/nestjs` deliberately doesn't re-export it so its type graph stays independent.

### Fastify

```ts
app.getHttpAdapter().getInstance().all("/board/*", (req, reply) => {
  getRequestListener(board.fetch)(req.raw, reply.raw)
})
```

### @InjectBoard

Inject the Board into services that need runtime access (e.g. to attach custom Hono routes):

```ts
import { InjectBoard } from "@taskora/nestjs"
import type { Board } from "@taskora/board"

@Injectable()
class BoardIntegrationService {
  constructor(@InjectBoard() private readonly board: Board) {}
}
```

## Multi-app

One Nest container hosting multiple independent taskora apps.

```ts
@Module({
  imports: [
    TaskoraModule.forRoot({ adapter: criticalAdapter }),
    TaskoraModule.forRoot({ name: "batch", adapter: batchAdapter }),
  ],
})
export class AppModule {}
```

```ts
@TaskConsumer(placeOrderTask)                             // → default app
class OrderConsumer {}

@TaskConsumer(analyticsRollupTask, { app: "batch" })       // → "batch" app
class RollupConsumer {}

@Injectable()
class OrderService {
  constructor(
    readonly critical: TaskoraRef,                            // default
    @InjectTaskoraRef("batch") readonly batch: TaskoraRef,    // named
  ) {}
}
```

Each app has its own worker loop, subscribe stream, Inspector, DLQ, schedules. Fully isolated.

## Producer/worker split

### Shared contracts package

```
services/
├── api/                ← producer
├── worker/             ← consumer
└── packages/tasks/     ← @tasks/contracts — zero deps, just defineTask calls
```

### API (producer-only)

```ts
TaskoraModule.forRoot({
  adapter: redisAdapter({ client: new Redis(process.env.REDIS_URL!) }),
  autoStart: false,    // explicit: no workers in this process
})
```

Only import producer services that dispatch via `TaskoraRef`. Don't register any `@TaskConsumer` classes. Even with `autoStart: true`, taskora's contract-only short-circuit skips worker loops when no task has a handler — but `autoStart: false` makes the intent unmistakable.

### Worker (consumer-only, no HTTP)

```ts
// services/worker/src/main.ts
import "reflect-metadata"
import { NestFactory } from "@nestjs/core"
import { WorkerModule } from "./worker.module"

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule)
  app.enableShutdownHooks()
  // NO app.listen() — the App IS the server, processing jobs forever.
}
bootstrap()
```

Use `createApplicationContext` instead of `create` — skips the Express/Fastify HTTP adapter entirely. Pure DI container + lifecycle hooks.

## Testing — TaskoraTestHarness

Import from `@taskora/nestjs/testing` (separate subpath).

### Vitest config (prerequisite)

Vitest's default esbuild transform does NOT emit decorator metadata. Install SWC:

```bash
npm install -D unplugin-swc @swc/core
```

```ts
// vitest.config.ts
import swc from "unplugin-swc"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    setupFiles: ["./tests/setup.ts"],
  },
})
```

```ts
// tests/setup.ts
import "reflect-metadata"
```

### createTaskoraTestHarness — end-to-end unit testing

```ts
import { createTaskoraTestHarness } from "@taskora/nestjs/testing"

it("sends the welcome email", async () => {
  const harness = await createTaskoraTestHarness({
    providers: [SendEmailConsumer, MailerService],
  })

  const result = await harness.execute(sendEmailTask, {
    to: "alice@example.com",
    subject: "Welcome",
  })

  expect(result.state).toBe("completed")
  expect(result.result?.messageId).toBeDefined()

  // DI deps are the real singletons — assert on their state:
  const mailer = harness.moduleRef.get(MailerService)
  expect(mailer.sent).toEqual(["alice@example.com"])

  await harness.close()
})
```

**What it does under the hood:**
1. Compiles a Nest `TestingModule` with `TaskoraTestingModule.forRoot({ autoStart: true })` pre-imported (memory adapter).
2. Runs `moduleRef.init()` → explorer runs → every `@TaskConsumer` gets registered → `app.start()` spins up the worker loop.
3. Returns a harness that routes `dispatch` / `execute` through the running App.

**Events fire naturally** — the harness runs the real subscribe stream, so `@OnTaskEvent` bindings are exercised end-to-end:

```ts
it("fires @OnTaskEvent on completion", async () => {
  const harness = await createTaskoraTestHarness({
    providers: [SendEmailConsumer, MailerService],
  })

  await harness.execute(sendEmailTask, { to: "bob@x", subject: "Hi" })

  const consumer = harness.moduleRef.get(SendEmailConsumer)
  expect(consumer.completedCount).toBeGreaterThanOrEqual(1)

  await harness.close()
})
```

### Harness API

- `harness.dispatch(contract, data, options?)` → `ResultHandle<O>`
- `harness.execute(contract, data, options?)` → `Promise<ExecuteResult<O>>` — dispatch + await + compact summary. **Errors don't throw** — `state: "failed"` + `error: string`.
- `harness.inspect(contract, jobId)` → `Promise<JobInfo | null>`
- `harness.moduleRef`, `harness.app`, `harness.tasks` — escape hatches
- `harness.close()` — tears down module, drains jobs, closes adapter

### ExecuteResult

```ts
interface ExecuteResult<TOutput> {
  id: string
  state: "completed" | "failed" | "cancelled" | "expired"
  result: TOutput | undefined
  error: string | undefined
  attempts: number
  logs: Taskora.LogEntry[]
  progress: number | Record<string, unknown> | undefined
  timeline: { dispatched: number; processed?: number; finished?: number }
}
```

### TaskoraTestingModule (lower-level primitive)

If you don't need the harness and just want a Nest testing module without Redis:

```ts
import { Test } from "@nestjs/testing"
import { TaskoraTestingModule } from "@taskora/nestjs/testing"

const moduleRef = await Test.createTestingModule({
  imports: [TaskoraTestingModule.forRoot()],   // memory + autoStart: false
  providers: [EmailService],
}).compile()

await moduleRef.init()
// ...
await moduleRef.close()
```

### Virtual time

The harness uses **real time**. For virtual-time tests (fast-forwarding delayed jobs, testing schedules, deterministic retries), drop down to `taskora/test`'s `createTestRunner()` directly — construct a fresh App and wrap it. The harness deliberately doesn't merge both worlds because dual-backend setups are fragile.

## main.ts — production bootstrap checklist

```ts
// src/main.ts
import "reflect-metadata"                // 1. FIRST LINE
import { NestFactory } from "@nestjs/core"
import { AppModule } from "./app.module"

async function bootstrap() {
  const app = await NestFactory.create(AppModule)

  app.enableShutdownHooks()              // 2. drain jobs on SIGTERM

  // 3. Optional: mount the board
  // const board = app.get<Board>(getBoardToken())
  // app.use("/board", getRequestListener(board.fetch))

  await app.listen(3000)                  // 4. bind HTTP
}

bootstrap()
```

## Common gotchas

- **`cannot read property 'for' of undefined` inside a service**: Vitest is running without `unplugin-swc`, so decorator metadata isn't emitted. Install SWC per the Testing section.
- **Job disappeared before inspector could read it**: you're calling `inspector.find(taskName, jobId)` which resolves to the wrong overload. Use `inspector.find(jobId)` (cross-task search) or `inspector.find(task, jobId)` with a `Task` object.
- **Middleware class listed but not found**: forgot to add the class to `providers: []` in the module. Explorer throws a clear message pointing at it.
- **SIGTERM kills jobs immediately**: `app.enableShutdownHooks()` wasn't called in `main.ts`. Without it, Nest doesn't propagate shutdown to `OnApplicationShutdown` providers.
- **Board options missing auth**: `cookiePassword` must be ≥ 32 chars. Taskora throws at `createBoard` time if shorter.
- **Two `forRoot` calls in different modules**: only call `forRoot` in `AppModule` (or a shared `CoreModule`). `@Global` exposes the App to every feature module. Feature modules that need per-contract providers use `forFeature`.
- **`@TaskConsumer` class has no `process()` method**: explorer throws at init. The method must be named exactly `process` and take `(data, ctx)`.
- **`@TaskConsumer` for the same contract registered twice**: taskora's `app.implement` throws on double-implement. If you need both a default and a named consumer for the same contract, use `@TaskConsumer(contract, { app: 'secondary' })` on the second one.

## Public API reference

### From `@taskora/nestjs`

```ts
// Modules
TaskoraModule                             // forRoot, forRootAsync, forFeature
TaskoraCoreModule                         // @Global, internal — usually don't use directly
TaskoraBoardModule                        // forRoot

// Injectable classes
TaskoraRef                                // .for(contract), .raw
TaskoraExplorer                           // internal but exported

// Decorators — producer side
@InjectApp(name?)                         // raw App
@InjectTaskoraRef(name?)                  // named TaskoraRef
@InjectTask(contract, appName?)           // per-contract BoundTask (requires forFeature)

// Decorators — consumer side
@TaskConsumer(contract, options?)         // class-level marker
@OnTaskEvent(event)                       // method-level event binding
@TaskMiddleware()                         // class-level, applies @Injectable

// Decorators — observability / admin
@InjectInspector(name?)
@InjectDeadLetters(name?)
@InjectSchedules(name?)
@InjectBoard(name?)

// Tokens
DEFAULT_APP_NAME
getAppToken(name?)
getOptionsToken(name?)
getExplorerToken(name?)
getTaskoraRefToken(name?)
getTaskToken(contract, appName?)
getInspectorToken(name?)
getDeadLettersToken(name?)
getSchedulesToken(name?)
getBoardToken(name?)

// Types
TaskoraModuleOptions
TaskoraModuleAsyncOptions
TaskoraModuleOptionsFactory
TaskoraMiddleware
TaskConsumerOptions
TaskConsumerMetadata
TaskEventBinding
InferBoundTask<C>                         // convenience for BoundTask<InferInput<C>, InferOutput<C>>

// Re-exports from taskora (for convenience)
InferInput<C>
InferOutput<C>
```

### From `@taskora/nestjs/testing`

```ts
TaskoraTestingModule                       // forRoot(options?) — memory defaults
createTaskoraTestHarness(options)          // builder → TaskoraTestHarness
TaskoraTestHarness                         // dispatch, execute, inspect, close

TaskoraTestHarnessOptions
TaskoraTestingModuleOptions
ExecuteResult<T>
```

### From `taskora` (for type annotations)

```ts
import { defineTask, createTaskora, App, BoundTask } from "taskora"
import type { Taskora, TaskContract, InferInput, InferOutput } from "taskora"
import { Inspector, DeadLetterManager } from "taskora"
```
