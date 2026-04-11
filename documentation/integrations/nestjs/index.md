# NestJS Integration

`@taskora/nestjs` is the first-class Nest integration for taskora. It wires the full producer + consumer surface into Nest's DI graph so your task code feels native to the framework — no bullmq-style boilerplate, no factory ceremony, no duplicate type annotations.

Everything taskora exposes (dispatching, handlers, events, middleware, inspector, DLQ, schedules, the admin dashboard, and an end-to-end test harness) is injectable. Constructor DI just works — including for `@TaskConsumer` classes that run as workers.

## 30-second tour

```ts
// src/tasks/contracts.ts
import { defineTask } from "taskora"
import { z } from "zod"

export const sendEmailTask = defineTask({
  name: "send-email",
  input: z.object({ to: z.string().email(), subject: z.string() }),
  output: z.object({ messageId: z.string() }),
})
```

```ts
// src/email/email.consumer.ts
import { TaskConsumer, OnTaskEvent } from "@taskora/nestjs"
import type { InferInput, InferOutput, Taskora } from "taskora"
import { MailerService } from "./mailer.service"
import { sendEmailTask } from "../tasks/contracts"

@TaskConsumer(sendEmailTask, { concurrency: 10 })
export class SendEmailConsumer {
  constructor(private readonly mailer: MailerService) {}

  async process(
    data: InferInput<typeof sendEmailTask>,
    _ctx: Taskora.Context,
  ): Promise<InferOutput<typeof sendEmailTask>> {
    return this.mailer.send(data)
  }

  @OnTaskEvent("completed")
  onSent() {
    // metrics, logs, whatever — DI dependencies are alive here
  }
}
```

```ts
// src/email/email.service.ts
import { Injectable } from "@nestjs/common"
import { TaskoraRef } from "@taskora/nestjs"
import { sendEmailTask } from "../tasks/contracts"

@Injectable()
export class EmailService {
  constructor(private readonly tasks: TaskoraRef) {}

  async notifySignup(user: { email: string; name: string }) {
    // Full type safety — no manual BoundTask<I, O> annotation.
    await this.tasks.for(sendEmailTask).dispatch({
      to: user.email,
      subject: `Welcome, ${user.name}`,
    })
  }
}
```

```ts
// src/app.module.ts
import { Module } from "@nestjs/common"
import { TaskoraModule } from "@taskora/nestjs"
import { redisAdapter } from "taskora/redis"
import { Redis } from "ioredis"
import { SendEmailConsumer } from "./email/email.consumer"
import { EmailService } from "./email/email.service"
import { MailerService } from "./email/mailer.service"

@Module({
  imports: [
    TaskoraModule.forRoot({
      adapter: redisAdapter({ client: new Redis(process.env.REDIS_URL!) }),
    }),
  ],
  providers: [SendEmailConsumer, EmailService, MailerService],
})
export class AppModule {}
```

That's it. `main.ts` is standard Nest bootstrap:

```ts
import "reflect-metadata"
import { NestFactory } from "@nestjs/core"
import { AppModule } from "./app.module"

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.enableShutdownHooks() // so @taskora/nestjs can drain jobs on SIGTERM
  await app.listen(3000)
}
bootstrap()
```

## What you get

- **`TaskoraModule.forRoot` / `forRootAsync`** — register taskora in the Nest container exactly like `TypeOrmModule` or `BullModule`.
- **`TaskoraRef.for(contract)`** — zero-decorator, fully inferred dispatchers. Replaces the duplicated `BoundTask<I, O>` annotations you'd get from property-style injection.
- **`@TaskConsumer(contract)`** — mark any provider as a worker handler. Full DI in the constructor, `process(data, ctx)` method runs inside the real worker loop.
- **`@OnTaskEvent('completed' | 'failed' | …)`** — method-level bindings for per-task events.
- **Class middleware** — `@TaskMiddleware()` providers composed via `forRoot({ middleware })`, Koa-style onion chain with live DI dependencies.
- **Observability accessors** — `Inspector`, `DeadLetterManager`, and the schedule manager are injectable via class tokens (zero decorator) or `@InjectInspector` / `@InjectDeadLetters` / `@InjectSchedules` for named apps.
- **`TaskoraBoardModule`** — optional dynamic import of `@taskora/board`; mount the admin dashboard from `main.ts` with three lines.
- **Multi-app** — every decorator and module method takes an optional `name` so one Nest container can host multiple independent taskora apps (separate Redis clusters, per-tenant isolation, etc.).
- **`@taskora/nestjs/testing`** — opt-in subpath with `TaskoraTestHarness`, a pre-wired memory-adapter testing module that runs the real producer + consumer pipeline end-to-end in milliseconds, no Redis / Docker required.

## Installation

::: pm-add @taskora/nestjs taskora reflect-metadata
:::

For the Redis adapter (production):

::: pm-add taskora ioredis
:::

For the admin dashboard (optional):

::: pm-add @taskora/board hono @hono/node-server
:::

`reflect-metadata` is a peer dependency — Nest needs it loaded before any decorated class is evaluated. Import it once at the top of `main.ts`:

```ts
import "reflect-metadata"
```

## TypeScript configuration

Nest's constructor DI relies on emitted decorator metadata. Make sure your `tsconfig.json` has both flags:

```jsonc
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

Without `emitDecoratorMetadata`, `constructor(private tasks: TaskoraRef)` silently resolves to `undefined` and every job throws on the first dispatch. If you're using SWC or esbuild (e.g. vitest default transform), you need the equivalent flag in their configs — see [Testing](./testing) for details.

## Next steps

1. [**File layout**](./file-layout) — recommended project structure for contracts, consumers, and modules.
2. [**Dispatching**](./dispatching) — `TaskoraRef.for()`, `@InjectTask`, and `forFeature`.
3. [**Consumers**](./consumers) — `@TaskConsumer`, `@OnTaskEvent`, lifecycle.
4. [**Middleware**](./middleware) — class middleware with DI.
5. [**Observability**](./observability) — inspector, DLQ, schedules as injectable services.
6. [**Admin dashboard**](./board) — mounting `@taskora/board` in a Nest app.
7. [**Testing**](./testing) — `TaskoraTestHarness` patterns.
8. [**Deployment**](./deployment) — multi-app, producer/worker split, graceful shutdown.
