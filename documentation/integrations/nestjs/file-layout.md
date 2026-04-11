# File Layout

How you arrange taskora code inside a Nest project matters — not for correctness (taskora doesn't care where files live), but for the team. A consistent layout makes it obvious where to add a new task, where a handler lives, and which services are allowed to dispatch what.

This page covers the layout patterns that scale. Start with the monolith, split only when you have a concrete reason.

## The monolith (recommended default)

```
src/
├── main.ts
├── app.module.ts
├── tasks/                         ← all task contracts live here
│   ├── index.ts                   ← re-exports every contract
│   ├── email.contracts.ts
│   ├── image.contracts.ts
│   └── webhook.contracts.ts
├── email/
│   ├── email.module.ts            ← feature module
│   ├── email.service.ts           ← producer: dispatches via TaskoraRef
│   ├── email.consumer.ts          ← @TaskConsumer for sendEmailTask
│   └── mailer.service.ts          ← injected into the consumer
├── image/
│   ├── image.module.ts
│   ├── image.controller.ts        ← producer: triggers dispatches from HTTP
│   ├── image.consumer.ts
│   └── sharp-pipeline.service.ts
└── common/
    ├── middleware/                ← class middleware
    │   └── logging.middleware.ts
    └── observability/             ← admin/observability HTTP endpoints
        └── queue-stats.controller.ts
```

### Why contracts live in `tasks/`, not inside feature folders

Contracts are the single source of truth for both producers and consumers. Even in a monolith you'll eventually have services that dispatch a task they don't own — `BillingService` dispatching `sendEmailTask`, for example. Keeping contracts in one shared folder means:

- Producers never reach into a feature folder to grab a contract. The import path says "shared thing", not "internal to email module".
- Renaming or reshaping a contract's input schema is one file, caught at compile time everywhere.
- When you eventually split the worker out of the monolith (see below), you already know which files go to the shared package.

### Why consumers live next to the code they call

A consumer is a thin DI wrapper around domain logic — it calls a `MailerService` or `SharpPipelineService`. Keeping the consumer in the same folder as its dependencies means:

- The feature module's `providers: []` array is the full registration surface for that feature.
- You can read the consumer and its dependencies without jumping between folders.
- When you delete the feature, everything goes with it.

## The composition

```ts
// src/tasks/email.contracts.ts
import { defineTask } from "taskora"
import { z } from "zod"

export const sendEmailTask = defineTask({
  name: "send-email",
  input: z.object({ to: z.string().email(), subject: z.string() }),
  output: z.object({ messageId: z.string() }),
})

export const sendWelcomeEmailTask = defineTask({
  name: "send-welcome-email",
  input: z.object({ userId: z.string().uuid() }),
})
```

```ts
// src/tasks/index.ts — one barrel so producers import from "@/tasks"
export * from "./email.contracts"
export * from "./image.contracts"
export * from "./webhook.contracts"
```

```ts
// src/email/email.module.ts
import { Module } from "@nestjs/common"
import { EmailService } from "./email.service"
import { SendEmailConsumer } from "./email.consumer"
import { MailerService } from "./mailer.service"

@Module({
  providers: [EmailService, SendEmailConsumer, MailerService],
  exports: [EmailService],
})
export class EmailModule {}
```

```ts
// src/email/email.service.ts — the producer
import { Injectable } from "@nestjs/common"
import { TaskoraRef } from "@taskora/nestjs"
import { sendEmailTask, sendWelcomeEmailTask } from "../tasks"

@Injectable()
export class EmailService {
  constructor(private readonly tasks: TaskoraRef) {}

  notifySignup(userId: string) {
    return this.tasks.for(sendWelcomeEmailTask).dispatch({ userId })
  }

  notifyReset(email: string) {
    return this.tasks.for(sendEmailTask).dispatch({
      to: email,
      subject: "Reset your password",
    })
  }
}
```

```ts
// src/email/email.consumer.ts — the worker
import { TaskConsumer } from "@taskora/nestjs"
import type { InferInput, InferOutput, Taskora } from "taskora"
import { MailerService } from "./mailer.service"
import { sendEmailTask } from "../tasks"

@TaskConsumer(sendEmailTask, {
  concurrency: 10,
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
}
```

```ts
// src/app.module.ts
import { Module } from "@nestjs/common"
import { TaskoraModule } from "@taskora/nestjs"
import { redisAdapter } from "taskora/redis"
import { Redis } from "ioredis"
import { EmailModule } from "./email/email.module"
import { ImageModule } from "./image/image.module"

@Module({
  imports: [
    TaskoraModule.forRootAsync({
      useFactory: () => ({
        adapter: redisAdapter({ client: new Redis(process.env.REDIS_URL!) }),
        defaults: { retry: { attempts: 3, backoff: "exponential" } },
      }),
    }),
    EmailModule,
    ImageModule,
  ],
})
export class AppModule {}
```

The `TaskoraModule` goes at the root. `EmailModule` and `ImageModule` don't need to re-import it — `TaskoraCoreModule` is `@Global`, so `TaskoraRef` and all accessor tokens are resolvable from anywhere in the container.

## When to split: producer ≠ worker

Two legitimate reasons to split the monolith:

1. **Heavy worker dependencies don't belong in your API image.** If the worker uses `sharp`, `puppeteer`, `ffmpeg`, native bindings, or ML models, dragging them into the API bundle doubles deploy size and slows cold starts.
2. **Independent scaling characteristics.** API auto-scales on HTTP traffic, worker scales on queue depth. If the ratio diverges a lot, splitting wins.

If neither applies, stay monolithic.

### Shared package layout (same monorepo)

```
services/
├── api/
│   ├── src/
│   │   ├── main.ts                ← Nest bootstrap, no worker
│   │   └── app.module.ts          ← TaskoraModule.forRoot({ ..., autoStart: false })
│   └── package.json               ← depends on @taskora/nestjs + @tasks/contracts
├── worker/
│   ├── src/
│   │   ├── main.ts                ← Nest bootstrap, consumers only
│   │   └── worker.module.ts       ← TaskoraModule.forRoot + @TaskConsumer providers
│   └── package.json               ← depends on @taskora/nestjs + @tasks/contracts + heavy deps
└── packages/
    └── tasks/
        ├── src/
        │   ├── index.ts
        │   ├── email.contracts.ts
        │   └── image.contracts.ts
        └── package.json           ← @tasks/contracts — zero runtime deps, just schemas
```

The shared `@tasks/contracts` package exports only `defineTask(...)` calls. Both the API and the worker import contracts from there. The API never imports consumer files; the worker never imports API controller files. The only thing they agree on is the contract shape.

### Producer-only bootstrap

In the API process, no `@TaskConsumer` providers are registered. That means `App.start()` has nothing to start a worker for, and even if `autoStart: true`, taskora's contract-only short-circuit skips the worker loop entirely. You can still set `autoStart: false` explicitly for extra clarity:

```ts
// services/api/src/app.module.ts
TaskoraModule.forRoot({
  adapter: redisAdapter({ client: new Redis(process.env.REDIS_URL!) }),
  autoStart: false, // pure producer — no workers, no subscribers
})
```

### Worker-only bootstrap

In the worker process, register every `@TaskConsumer` class and let `TaskoraModule.forRoot` start the App normally. No HTTP adapter needed — use `NestFactory.createApplicationContext` instead of `NestFactory.create`:

```ts
// services/worker/src/main.ts
import "reflect-metadata"
import { NestFactory } from "@nestjs/core"
import { WorkerModule } from "./worker.module"

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule)
  app.enableShutdownHooks()
  // No listen() — the App is the "HTTP server" equivalent, processing jobs forever.
}
bootstrap()
```

`createApplicationContext` skips Express/Fastify setup entirely. You get a pure DI container with lifecycle hooks, which is exactly what a worker process needs.

## Anti-patterns

### Don't scatter contracts across feature folders

```
❌
src/
├── email/
│   ├── email.contracts.ts     ← bad: siloed
│   └── email.module.ts
└── billing/
    └── billing.service.ts     ← imports "../email/email.contracts"? No.
```

Contracts moved because of a refactor? Now `billing.service.ts` has a broken import and the search-replace touches every service. Keep contracts in one place from day one.

### Don't put dispatchers in controllers

```
❌
@Controller("users")
export class UsersController {
  constructor(private tasks: TaskoraRef) {}

  @Post("signup")
  async signup(@Body() dto: SignupDto) {
    // Controller directly dispatches a task
    await this.tasks.for(sendWelcomeEmailTask).dispatch({ userId: dto.id })
  }
}
```

The controller has no business knowing about the email task. Put the dispatch inside a `UserService.onSignup()` method and have the controller call the service. Same reasoning as putting SQL queries or Redis calls inside a service, not a controller — separation of layers.

### Don't register consumers in the same module as their producers

Consumers and producers for the same task are structurally independent — in a split deployment they live in different processes. Even in a monolith, keep them in separate modules (`EmailModule` contains `EmailService` + `SendEmailConsumer`, but `BillingModule` can also dispatch `sendEmailTask` via `TaskoraRef` without importing anything from `EmailModule`).

### Don't use `TaskoraModule.forRoot` in a feature module

`forRoot` creates and owns the App. Only call it once, in `AppModule` (or a shared `CoreModule`). Feature modules that need per-contract providers can use [`forFeature`](./dispatching#forfeature) — but most of the time `TaskoraRef.for(contract)` removes the need for `forFeature` entirely.

## Summary

- **Contracts in `src/tasks/`**, one folder, one barrel.
- **Consumers next to their dependencies**, inside the feature module that owns the domain logic.
- **Dispatchers in service classes**, not controllers.
- **`TaskoraModule.forRoot` only in `AppModule`**, `@Global` handles the rest.
- **Split producer/worker only when you have a concrete pain** — heavy deps or divergent scaling. Otherwise the monolith wins on simplicity.
