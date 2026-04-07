# Conventions

Taskora conventions that keep codebases consistent as they grow. Follow these and your tasks will be easy to find, read, and debug.

## Naming

### Instance: `taskora`

Always name your instance `taskora`. Never `app` — too generic, conflicts with Express/Fastify/Hono.

```ts
import { createTaskora } from "taskora"

const taskora = createTaskora({
  adapter: redisAdapter("redis://localhost"),
})
```

### Tasks: `*Task` suffix

Every task variable ends with `Task`. This instantly distinguishes tasks from regular functions and services.

```ts
// ✓ Clear what's a task
const sendEmailTask = taskora.task("send-email", { ... })
const processImageTask = taskora.task("process-image", { ... })
const chargeCardTask = taskora.task("charge-card", { ... })

// ✗ Ambiguous — is this a function or a task?
const sendEmail = taskora.task("send-email", { ... })
```

This matters most when you have both:

```ts
// The function that actually sends email
async function sendEmail(to: string, body: string) { ... }

// The task that wraps it for async processing
const sendEmailTask = taskora.task("send-email", {
  handler: async (data) => sendEmail(data.to, data.body),
})
```

### Task string names: kebab-case

The first argument to `taskora.task()` is the task's identity — it maps to Redis keys and must be stable.

```ts
// ✓ kebab-case
taskora.task("send-email", { ... })
taskora.task("process-image", { ... })
taskora.task("generate-invoice", { ... })

// ✗ Other styles
taskora.task("sendEmail", { ... })       // camelCase
taskora.task("send_email", { ... })      // snake_case
taskora.task("SendEmail", { ... })       // PascalCase
```

### Workflow handles: descriptive names

```ts
const onboardingFlow = chain(
  createUserTask.s({ name: "John" }),
  sendWelcomeEmailTask.s(),
  notifySlackTask.s(),
).dispatch()

const batchResult = processImageTask.map(images)
```

## Project Structure

### Recommended layout

```
src/
├── taskora.ts              ← createTaskora + config
├── tasks/
│   ├── email.ts            ← sendEmailTask, sendWelcomeEmailTask
│   ├── billing.ts          ← chargeCardTask, generateInvoiceTask
│   └── notifications.ts   ← notifySlackTask, sendPushTask
├── workflows/
│   └── onboarding.ts       ← onboarding chain
└── worker.ts               ← taskora.start()
```

### With a Telegram bot (GramIO)

```
src/
├── taskora.ts                ← createTaskora + config
├── bot.ts                    ← GramIO bot instance
├── tasks/
│   ├── notifications.ts      ← sendTelegramMessageTask, broadcastTask
│   ├── moderation.ts         ← checkSpamTask, banUserTask
│   └── media.ts              ← processPhotoTask, generateThumbnailTask
├── bot/
│   ├── commands/
│   │   ├── start.ts          ← /start — dispatches welcome task
│   │   └── settings.ts       ← /settings
│   └── callbacks/
│       └── subscribe.ts      ← inline button → dispatches task
├── workflows/
│   └── onboarding.ts         ← welcome message chain
└── index.ts                  ← bot.start() + taskora.start()
```

```ts
// src/tasks/notifications.ts
import { taskora } from "../taskora.js"

export const sendTelegramMessageTask = taskora.task("send-telegram-message", {
  retry: { attempts: 3, backoff: "exponential", delay: 2000 },
  handler: async (data: { chatId: number; text: string }) => {
    // Rate-limited — offloaded from bot handler to task queue
    await bot.api.sendMessage({ chat_id: data.chatId, text: data.text })
    return { sent: true }
  },
})

export const broadcastTask = taskora.task("broadcast", {
  timeout: 300_000, // 5 min for large broadcasts
  handler: async (data: { chatIds: number[]; text: string }, ctx) => {
    let sent = 0
    for (const chatId of data.chatIds) {
      if (ctx.signal.aborted) break
      sendTelegramMessageTask.dispatch({ chatId, text: data.text })
      sent++
      ctx.progress(sent / data.chatIds.length)
    }
    return { sent }
  },
})
```

```ts
// src/bot/commands/start.ts — bot handler dispatches task
import { sendTelegramMessageTask } from "../../tasks/notifications.js"

bot.command("start", async (context) => {
  // Respond immediately
  await context.send("Welcome! Setting things up...")

  // Heavy work goes to the queue
  sendTelegramMessageTask.dispatch({
    chatId: context.chatId,
    text: "Your account is ready! Here's what you can do...",
  })
})
```

### With a REST API (Elysia)

```
src/
├── taskora.ts                ← createTaskora + config
├── server.ts                 ← Elysia instance
├── tasks/
│   ├── email.ts              ← sendEmailTask, sendInvoiceTask
│   ├── reports.ts            ← generateReportTask, exportCsvTask
│   └── webhooks.ts           ← deliverWebhookTask
├── routes/
│   ├── orders.ts             ← POST /orders → dispatches tasks
│   └── reports.ts            ← POST /reports → dispatches task, returns handle
├── workflows/
│   └── order-fulfillment.ts  ← chain: validate → charge → ship → notify
└── index.ts                  ← server.listen() + taskora.start()
```

```ts
// src/routes/orders.ts — Elysia route dispatches workflow
import { Elysia, t } from "elysia"
import { chain } from "taskora"
import { validateOrderTask, chargePaymentTask, sendConfirmationTask } from "../tasks/orders.js"

export const orderRoutes = new Elysia({ prefix: "/orders" })
  .post("/", async ({ body }) => {
    // Dispatch workflow, return immediately
    const handle = chain(
      validateOrderTask.s(body),
      chargePaymentTask.s(),
      sendConfirmationTask.s(),
    ).dispatch()

    await handle // ensure dispatched
    return { orderId: handle.workflowId, status: "processing" }
  }, {
    body: t.Object({
      items: t.Array(t.Object({ sku: t.String(), qty: t.Number() })),
      email: t.String(),
    }),
  })
```

```ts
// src/routes/reports.ts — long-running task with polling
import { Elysia, t } from "elysia"
import { generateReportTask } from "../tasks/reports.js"

export const reportRoutes = new Elysia({ prefix: "/reports" })
  .post("/", async ({ body }) => {
    const handle = generateReportTask.dispatch(body)
    const id = await handle
    return { reportId: id, status: "generating" }
  })
  .get("/:id/status", async ({ params }) => {
    const state = await generateReportTask.inspect(params.id)
    return { status: state }
  })
```

### taskora.ts — single source

Define `createTaskora` once, export the instance. All task files import from here.

```ts
// src/taskora.ts
import { createTaskora } from "taskora"
import { redisAdapter } from "taskora/redis"

export const taskora = createTaskora({
  adapter: redisAdapter(process.env.REDIS_URL!),
  defaults: {
    retry: { attempts: 3, backoff: "exponential", delay: 1000 },
    timeout: 30_000,
  },
})
```

### One file per domain

Group tasks by business domain, not by technical concern.

```ts
// src/tasks/email.ts
import { taskora } from "../taskora.js"

export const sendEmailTask = taskora.task("send-email", {
  handler: async (data: { to: string; subject: string; body: string }) => {
    return await mailer.send(data)
  },
})

export const sendWelcomeEmailTask = taskora.task("send-welcome-email", {
  handler: async (data: { userId: string }) => {
    const user = await db.users.find(data.userId)
    return await mailer.send({ to: user.email, subject: "Welcome!", body: "..." })
  },
})
```

### worker.ts — import tasks, start

```ts
// src/worker.ts
import { taskora } from "./taskora.js"

// Import all task files so they register on the taskora instance
import "./tasks/email.js"
import "./tasks/billing.js"
import "./tasks/notifications.js"

await taskora.start()
console.log("Worker started")
```

## Handler Patterns

### Return serializable values

Handler results are serialized (JSON by default). Return plain objects, arrays, strings, numbers.

```ts
// ✓ Plain object
handler: async (data) => {
  const user = await db.users.create(data)
  return { id: user.id, email: user.email }
}

// ✗ Class instances, functions, circular refs
handler: async (data) => {
  return new User(data)  // won't serialize correctly
}
```

### Use `ctx.log`, not `console.log`

Logs via `ctx.log` are stored with the job and visible in the inspector.

```ts
handler: async (data, ctx) => {
  ctx.log.info("Processing started", { imageUrl: data.url })

  const result = await processImage(data.url)

  ctx.log.info("Processing complete", { size: result.size })
  return result
}
```

### Check `ctx.signal` in long operations

Pass the abort signal to APIs that support it:

```ts
handler: async (data, ctx) => {
  const response = await fetch(data.url, { signal: ctx.signal })
  const body = await response.json()
  return body
}
```

For manual checks in loops:

```ts
handler: async (data, ctx) => {
  for (const item of data.items) {
    if (ctx.signal.aborted) break
    await processItem(item)
    ctx.progress(processed++ / data.items.length)
  }
}
```

### Design for idempotency

Tasks may be retried. Write handlers that are safe to run twice with the same input.

```ts
// ✓ Idempotent — uses upsert
handler: async (data) => {
  await db.users.upsert({ email: data.email }, { name: data.name })
}

// ✗ Not idempotent — creates duplicates on retry
handler: async (data) => {
  await db.users.insert({ email: data.email, name: data.name })
}
```

### Guard clauses first

Check preconditions at the top, fail fast:

```ts
handler: async (data, ctx) => {
  const user = await db.users.find(data.userId)
  if (!user) throw new Error(`User ${data.userId} not found`)
  if (!user.verified) throw new Error(`User ${data.userId} not verified`)

  // Happy path
  return await sendEmail(user.email, data.template)
}
```

## Workflow Patterns

### When to use what

| Pattern | Use when |
|---|---|
| `chain(a, b, c)` | Steps must run in order, output flows forward |
| `group(a, b, c)` | Steps are independent, run in parallel |
| `chord([a, b], c)` | Parallel steps feed into a merge/reduce step |
| `task.map(items)` | Same task, many inputs, all parallel |
| `task.chunk(items, { size })` | Same task, many inputs, batched concurrency |

### Keep chains short

Long chains are hard to debug. If a chain has more than 5 steps, consider splitting into sub-workflows or rethinking the pipeline.

```ts
// ✓ Focused chain
const processOrderFlow = chain(
  validateOrderTask.s(orderData),
  chargePaymentTask.s(),
  sendConfirmationTask.s(),
).dispatch()

// ✗ Too long — where did it fail?
const flow = chain(a.s(), b.s(), c.s(), d.s(), e.s(), f.s(), g.s(), h.s()).dispatch()
```

### Name your workflows

Store workflow compositions in variables with descriptive names:

```ts
// src/workflows/onboarding.ts
import { chain } from "taskora"
import { createUserTask, sendWelcomeEmailTask, setupDefaultsTask } from "../tasks/users.js"

export function dispatchOnboarding(data: { name: string; email: string }) {
  return chain(
    createUserTask.s(data),
    sendWelcomeEmailTask.s(),
    setupDefaultsTask.s(),
  ).dispatch()
}
```

### Error boundaries

A failed step fails the entire workflow. For steps that can fail independently, use separate workflows or handle errors in the task handler:

```ts
// This handler won't break the chain if Slack is down
const notifySlackTask = taskora.task("notify-slack", {
  handler: async (data) => {
    try {
      await slack.send(data.channel, data.message)
      return { sent: true }
    } catch {
      return { sent: false }  // swallow error, don't break workflow
    }
  },
})
```
