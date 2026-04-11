# @taskora/nestjs

First-class NestJS integration for [taskora](https://github.com/kravetsone/taskora) — the TypeScript-first task queue for Node.js. Everything taskora exposes (dispatching, handlers, events, middleware, inspector, DLQ, schedules, admin dashboard, testing) is injectable through Nest's DI graph. Constructor injection just works — including for `@TaskConsumer` classes that run as workers.

Full docs: **https://kravetsone.github.io/taskora/integrations/nestjs/**

## Install

```bash
npm install @taskora/nestjs taskora reflect-metadata ioredis
```

Optional admin dashboard:

```bash
npm install @taskora/board hono @hono/node-server
```

Make sure `reflect-metadata` is imported at the top of `main.ts` and `tsconfig.json` has both decorator flags enabled:

```jsonc
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

## 30-second example

### Contracts

```ts
// src/tasks/email.contracts.ts
import { defineTask } from "taskora"
import { z } from "zod"

export const sendEmailTask = defineTask({
  name: "send-email",
  input: z.object({ to: z.string().email(), subject: z.string() }),
  output: z.object({ messageId: z.string() }),
})
```

### Consumer (DI-managed handler)

```ts
// src/email/email.consumer.ts
import { TaskConsumer, OnTaskEvent } from "@taskora/nestjs"
import type { InferInput, InferOutput, Taskora } from "taskora"
import { MailerService } from "./mailer.service"
import { sendEmailTask } from "../tasks/email.contracts"

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
    // metrics, logs — DI deps live here
  }
}
```

### Producer (zero-decorator, full type safety)

```ts
// src/email/email.service.ts
import { Injectable } from "@nestjs/common"
import { TaskoraRef } from "@taskora/nestjs"
import { sendEmailTask } from "../tasks/email.contracts"

@Injectable()
export class EmailService {
  constructor(private readonly tasks: TaskoraRef) {}

  notifySignup(email: string) {
    return this.tasks.for(sendEmailTask).dispatch({
      to: email,
      subject: "Welcome",
    })
  }
}
```

### Module

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

### Bootstrap

```ts
// src/main.ts
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

## What's in the box

- **`TaskoraModule.forRoot` / `forRootAsync`** — drop-in module registration with `ConfigService`-style async factories.
- **`TaskoraRef.for(contract)`** — zero-decorator, fully inferred dispatchers. Replaces manual `BoundTask<I, O>` annotations.
- **`@TaskConsumer(contract)`** — mark any provider as a worker handler. Full DI in the constructor, `process(data, ctx)` runs in the real worker loop.
- **`@OnTaskEvent('completed' | 'failed' | …)`** — method-level per-task event bindings with DI intact.
- **`@TaskMiddleware()`** — class middleware composed via `forRoot({ middleware })`. Koa-style onion chain with live DI dependencies.
- **`@InjectInspector` / `@InjectDeadLetters` / `@InjectSchedules`** — observability accessors. Default slot resolves via class tokens (zero decorator), named slots via `@Inject*('name')`.
- **`TaskoraBoardModule`** — optional `@taskora/board` admin dashboard, dynamically imported so unused → zero cost. Mount in `main.ts` with three lines.
- **Multi-app** — every decorator and module method takes an optional `name` for hosting multiple taskora apps in one Nest container.
- **`@taskora/nestjs/testing`** — opt-in subpath with `TaskoraTestHarness`, an end-to-end test runner over an in-memory adapter. No Redis, no Docker, milliseconds per test.

## Documentation

- [**Overview + installation**](https://kravetsone.github.io/taskora/integrations/nestjs/)
- [**File layout best practices**](https://kravetsone.github.io/taskora/integrations/nestjs/file-layout)
- [**Dispatching**](https://kravetsone.github.io/taskora/integrations/nestjs/dispatching)
- [**Consumers**](https://kravetsone.github.io/taskora/integrations/nestjs/consumers)
- [**Middleware**](https://kravetsone.github.io/taskora/integrations/nestjs/middleware)
- [**Observability**](https://kravetsone.github.io/taskora/integrations/nestjs/observability)
- [**Admin dashboard**](https://kravetsone.github.io/taskora/integrations/nestjs/board)
- [**Testing**](https://kravetsone.github.io/taskora/integrations/nestjs/testing)
- [**Deployment**](https://kravetsone.github.io/taskora/integrations/nestjs/deployment)

## AI agents

`@taskora/nestjs` ships a first-class [Agent Skill](https://github.com/kravetsone/taskora/tree/main/documentation/skills/taskora-nestjs) consumed by Claude Code, Cursor, Windsurf, Cline, and other AI coding agents. It's a curated quick-reference covering every public API, common patterns, and typical gotchas — treated as a first-class artifact, not auto-generated. Agents routed to this skill will produce correct, idiomatic code for the integration.

## License

MIT © [Kravets Sergey](https://github.com/kravetsone)
