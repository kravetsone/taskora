# Deployment

Covers production bootstrap patterns for Nest apps that use taskora: graceful shutdown, producer/worker split, multi-app, and the `main.ts` shapes that actually work.

## `main.ts` checklist

Every production bootstrap needs these four things:

```ts
import "reflect-metadata"                   // 1. reflect-metadata FIRST — before any decorated class evaluates
import { NestFactory } from "@nestjs/core"
import { AppModule } from "./app.module"

async function bootstrap() {
  const app = await NestFactory.create(AppModule)

  app.enableShutdownHooks()                 // 2. enable shutdown hooks so SIGTERM drains jobs

  // 3. Optional: mount the board (see /integrations/nestjs/board)
  // const board = app.get<Board>(getBoardToken())
  // app.use("/board", getRequestListener(board.fetch))

  await app.listen(3000)                    // 4. Bind HTTP
}

bootstrap()
```

### Why `enableShutdownHooks()` matters

`TaskoraExplorer` implements `OnApplicationShutdown` — it awaits `app.close()` on shutdown, which drains active jobs up to the stall timeout. Nest only calls shutdown hooks if you opt in with `enableShutdownHooks()`, so without this line a `SIGTERM` tears the process down immediately, orphaning every in-flight job. The job gets rescheduled later by stall detection, but you eat a duplicate execution.

### Why `import "reflect-metadata"` must be first

Nest's constructor DI depends on decorator metadata. If your first decorated class evaluates before reflect-metadata patches the global `Reflect` object, the metadata lookups fall back to `undefined` and providers inject as undefined. This shows up as cryptic errors like `Cannot read property 'for' of undefined` inside services that inject `TaskoraRef`.

The import **must** be the first line of `main.ts` — above every other import, including `NestFactory`.

## Monolith deployment

One process, one image, one Nest module. Everything lives together — API controllers, services, consumers, all in the same Redis.

```ts
// app.module.ts
@Module({
  imports: [
    TaskoraModule.forRootAsync({
      useFactory: () => ({
        adapter: redisAdapter({ client: new Redis(process.env.REDIS_URL!) }),
        defaults: {
          retry: { attempts: 3, backoff: "exponential" },
          timeout: 30_000,
        },
        stall: { interval: 30_000, maxCount: 1 },
        retention: {
          completed: { maxAge: "1h", maxItems: 500 },
          failed: { maxAge: "7d", maxItems: 1000 },
        },
      }),
    }),
    EmailModule,
    ImageModule,
    BillingModule,
  ],
})
export class AppModule {}
```

Scale this vertically first — taskora's default concurrency is 1 per task; bump it via `@TaskConsumer(contract, { concurrency: 20 })` for I/O-bound work. Node's event loop handles thousands of in-flight promises, and the only moving part is Redis. When vertical scaling stops paying off, horizontal-scale the monolith behind a load balancer — every process subscribes to the same Redis and pulls work independently.

## Producer/worker split

Two processes, shared contract package, same Redis. One scales on HTTP traffic, the other scales on queue depth.

### Shared contracts package

```
services/
├── api/
│   └── src/
│       ├── main.ts
│       └── api.module.ts           ← NO consumers, pure producer
├── worker/
│   └── src/
│       ├── main.ts                 ← no HTTP
│       └── worker.module.ts        ← all @TaskConsumer classes live here
└── packages/
    └── tasks/
        ├── src/
        │   ├── index.ts
        │   └── email.contracts.ts
        └── package.json            ← @tasks/contracts — zero runtime deps
```

### API module — pure producer

```ts
// services/api/src/api.module.ts
import { Module } from "@nestjs/common"
import { TaskoraModule } from "@taskora/nestjs"
import { redisAdapter } from "taskora/redis"
import { Redis } from "ioredis"
import { EmailModule } from "./email/email.module"

@Module({
  imports: [
    TaskoraModule.forRoot({
      adapter: redisAdapter({ client: new Redis(process.env.REDIS_URL!) }),
      autoStart: false, // ← explicit: this process never runs workers
    }),
    EmailModule, // only contains EmailService (producer), no consumer
  ],
})
export class ApiModule {}
```

`autoStart: false` is belt-and-braces — taskora's contract-only short-circuit in `App.start()` already skips worker loops when no task has a handler, so the API process wouldn't run workers anyway. But the explicit flag makes the intent unmistakable in code review.

The `EmailService` imports `sendEmailTask` from `@tasks/contracts`, registers it via `TaskoraRef.register(sendEmailTask)` (or implicitly via `TaskoraRef.for(sendEmailTask).dispatch(...)`), and dispatches normally. The contract is enough — no handler needed on this side.

### Worker module — no HTTP

```ts
// services/worker/src/worker.module.ts
import { Module } from "@nestjs/common"
import { TaskoraModule } from "@taskora/nestjs"
import { redisAdapter } from "taskora/redis"
import { Redis } from "ioredis"
import { EmailConsumer } from "./email/email.consumer"
import { ImageConsumer } from "./image/image.consumer"
import { MailerService } from "./email/mailer.service"
import { SharpPipelineService } from "./image/sharp-pipeline.service"

@Module({
  imports: [
    TaskoraModule.forRoot({
      adapter: redisAdapter({ client: new Redis(process.env.REDIS_URL!) }),
    }),
  ],
  providers: [
    EmailConsumer,
    ImageConsumer,
    MailerService,
    SharpPipelineService,
  ],
})
export class WorkerModule {}
```

### Worker bootstrap — `createApplicationContext`, not `create`

```ts
// services/worker/src/main.ts
import "reflect-metadata"
import { NestFactory } from "@nestjs/core"
import { WorkerModule } from "./worker.module"

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule)
  app.enableShutdownHooks()
  // Note: no app.listen() — the App is the "server". It processes jobs forever.
}

bootstrap()
```

`createApplicationContext` skips the Express/Fastify HTTP adapter entirely. You get a pure DI container + lifecycle hooks, which is exactly what a headless worker needs. No wasted port binding, no HTTP adapter startup, no `@nestjs/platform-express` dependency.

### Dockerfile for the split

One repo, one base image, two entry points:

```dockerfile
# ----- build stage -----
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY services/api/package.json ./services/api/
COPY services/worker/package.json ./services/worker/
COPY packages/tasks/package.json ./packages/tasks/
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# ----- api image -----
FROM node:22-alpine AS api
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/tasks/dist ./packages/tasks/dist
COPY --from=build /app/services/api/dist ./dist
CMD ["node", "dist/main.js"]

# ----- worker image -----
FROM node:22-alpine AS worker
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/tasks/dist ./packages/tasks/dist
COPY --from=build /app/services/worker/dist ./dist
# Heavy deps — only installed in the worker image
RUN apk add --no-cache vips ffmpeg
CMD ["node", "dist/main.js"]
```

`sharp`, `puppeteer`, `ffmpeg`, native bindings — none of them end up in the API image. The API image stays lean; the worker image pays the weight only where it's needed.

## Graceful shutdown

Nest calls `OnApplicationShutdown` hooks on every provider when it receives SIGINT/SIGTERM (if `enableShutdownHooks()` was called). The explorer implements the hook and awaits `app.close()`, which:

1. Stops the worker poll loop from picking up new jobs.
2. Waits for in-flight handlers to finish (up to their individual `timeout`).
3. Closes the adapter (Redis connections, event readers, subscribe streams).

Typical orchestrator flow (Kubernetes, ECS, systemd):

1. Orchestrator sends SIGTERM.
2. Nest triggers `OnApplicationShutdown` on all providers.
3. `TaskoraExplorer.onApplicationShutdown` awaits `app.close()`.
4. In-flight jobs complete or time out.
5. Nest finishes shutdown, process exits with code 0.

### Configuring the drain window

Set a per-task `timeout` that's **shorter** than your orchestrator's graceful shutdown window:

```ts
@TaskConsumer(processImageTask, {
  concurrency: 4,
  timeout: 25_000, // 25s handler timeout
})
```

If Kubernetes' `terminationGracePeriodSeconds` is 30, a 25s handler timeout guarantees every in-flight job either completes or aborts with a `TimeoutError` (which can retry per the retry config) before the pod is hard-killed.

### SIGKILL (hard stop)

If the process gets SIGKILL (OOM, orchestrator timeout), active jobs are orphaned in Redis. **Stall detection** recovers them on the next poll — the stalled job's lock expires, a worker picks it up again. This is the whole point of the stall machinery: hard crashes don't lose work, they just trigger a re-execution.

Tune `stall: { interval, maxCount }` per workload. The default (`interval: 30_000`, `maxCount: 1`) means a worker detects stalled jobs every 30s and re-queues them on the first stall, fails them permanently on the second.

## Multi-app

One Nest container, multiple independent taskora apps — useful for:

- **Per-tenant isolation** — each tenant gets its own Redis database, each with its own rate limits and DLQ.
- **Separate priority tiers** — a "critical" app with low concurrency + strict timeouts, a "batch" app with high concurrency + loose timeouts.
- **Gradual migration** — run an old and a new Redis in parallel, dual-dispatch, flip reads.

### Registration

```ts
@Module({
  imports: [
    TaskoraModule.forRootAsync({
      useFactory: (config: ConfigService) => ({
        adapter: redisAdapter({
          client: new Redis(config.getOrThrow("CRITICAL_REDIS_URL")),
        }),
        defaults: { retry: { attempts: 5 }, timeout: 5_000 },
      }),
      inject: [ConfigService],
    }),

    TaskoraModule.forRootAsync({
      name: "batch",
      useFactory: (config: ConfigService) => ({
        adapter: redisAdapter({
          client: new Redis(config.getOrThrow("BATCH_REDIS_URL")),
        }),
        defaults: { retry: { attempts: 1 }, timeout: 600_000 },
      }),
      inject: [ConfigService],
    }),
  ],
})
export class AppModule {}
```

### Routing consumers

```ts
@TaskConsumer(placeOrderTask)
class CriticalOrderConsumer { … }        // → default "critical" app

@TaskConsumer(analyticsRollupTask, { app: "batch" })
class BatchRollupConsumer { … }           // → "batch" app
```

### Routing dispatchers

```ts
@Injectable()
class OrderService {
  constructor(
    readonly critical: TaskoraRef,                           // default slot
    @InjectTaskoraRef("batch") readonly batch: TaskoraRef,   // named slot
  ) {}

  placeOrder(input: OrderInput) {
    return this.critical.for(placeOrderTask).dispatch(input)
  }

  scheduleRollup(day: string) {
    return this.batch.for(analyticsRollupTask).dispatch({ day })
  }
}
```

Each app has its own worker loop, its own subscribe stream, its own Inspector / DLQ / schedules. They don't share state. Cancelling a job in `critical` has no effect on `batch`.

### Multi-app boards

If you're mounting the admin dashboard for each app, use named boards:

```ts
TaskoraBoardModule.forRoot({ basePath: "/board/critical" })
TaskoraBoardModule.forRoot({ name: "batch", basePath: "/board/batch" })
```

See [Admin Dashboard > Multi-app / multi-board](./board#multi-app--multi-board).

## Health checks

A minimal health check for a taskora-backed Nest app:

```ts
import { Injectable } from "@nestjs/common"
import { InjectApp } from "@taskora/nestjs"
import type { App } from "taskora"

@Injectable()
export class TaskoraHealthIndicator {
  constructor(@InjectApp() private readonly app: App) {}

  async isHealthy() {
    try {
      // A no-op inspector call round-trips to the adapter and back.
      await this.app.inspect().stats()
      return { taskora: { status: "up" } }
    } catch (err) {
      return { taskora: { status: "down", error: (err as Error).message } }
    }
  }
}
```

Wire it into `@nestjs/terminus` or your custom health controller. `inspector.stats()` pipes an LLEN/ZCARD batch to Redis — cheap, non-mutating, a real connectivity check.

For readiness vs liveness: taskora's `worker:ready` event fires after `app.start()` finishes. If you expose `"ready"` only after observing this event once, the readiness probe naturally gates traffic on "workers actually pulling jobs":

```ts
@Injectable()
export class ReadinessState implements OnModuleInit {
  private ready = false
  constructor(@InjectApp() private readonly app: App) {}

  onModuleInit() {
    this.app.on("worker:ready", () => { this.ready = true })
  }

  isReady() { return this.ready }
}
```

## Environment variables

Mandatory for any production taskora Nest app:

| Variable | Purpose |
|---|---|
| `REDIS_URL` | Connection string for the taskora adapter |
| `NODE_ENV` | `production` disables dev-only logging and enables strict defaults |
| `BOARD_COOKIE_PASSWORD` | **≥ 32 chars**, required if you mount the board with auth |
| `BOARD_ADMIN_PASSWORD` | Passed to your `authenticate()` callback in board auth |

Recommended:

| Variable | Purpose |
|---|---|
| `REDIS_TLS_CA` | Client CA bundle if your Redis uses mTLS |
| `TASKORA_LOG_LEVEL` | Override log verbosity for the Nest `Logger("Taskora")` output |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OpenTelemetry export endpoint (if using a tracing middleware) |

## Cold starts

The explorer's discovery pass is O(N providers), a single synchronous walk during `onApplicationBootstrap`. For typical Nest apps with 50-500 providers this is sub-millisecond. The expensive part is Redis connection setup — `lazyConnect: true` (the default on `taskora/redis`) defers it until the first dispatch or `app.start()`, so HTTP startup isn't blocked on Redis.

If you want the app to fail fast on Redis connectivity issues during bootstrap instead of at first dispatch, wrap the adapter in a connect call:

```ts
TaskoraModule.forRootAsync({
  useFactory: async () => {
    const client = new Redis(process.env.REDIS_URL!, { lazyConnect: true })
    await client.connect()          // eager connect — throws if Redis is down
    return { adapter: redisAdapter({ client }) }
  },
})
```

For most applications, lazy is fine — health checks will catch a dead Redis before traffic is routed.
