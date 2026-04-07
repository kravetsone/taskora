# Getting Started

Get your first task queue running in under 5 minutes.

## Installation

::: pm-add taskora ioredis
:::

## Create Your App

Every taskora project starts with an instance — the central registry that holds your tasks, adapters, and configuration.

```ts
import { createTaskora } from "taskora"
import { redisAdapter } from "taskora/redis"

const taskora = createTaskora({
  adapter: redisAdapter("redis://localhost:6379"),
})
```

The adapter can accept a Redis URL string, an `ioredis` options object, or an existing `ioredis` instance.

## Define a Task

A task is a named function that processes data. Taskora infers the input and output types from your handler.

```ts
const sendEmailTask = taskora.task(
  "send-email",
  async (data: { to: string; subject: string; body: string }) => {
    // Your email sending logic
    const messageId = await mailer.send(data)
    return { messageId }
  },
)
```

## Dispatch a Job

Call `dispatch()` to enqueue a job. It returns a `ResultHandle` immediately — no `await` needed to enqueue.

```ts
const handle = sendEmailTask.dispatch({
  to: "user@example.com",
  subject: "Welcome!",
  body: "Thanks for signing up.",
})

// The handle is thenable — await it to get the job ID
const jobId = await handle // "550e8400-e29b-41d4-a716-446655440000"

// Or wait for the actual result
const result = await handle.result // { messageId: "..." }
```

## Start the Worker

Call `taskora.start()` to begin processing jobs. Workers automatically pick up jobs from Redis using blocking dequeue (BZPOPMIN) — no polling overhead.

```ts
await taskora.start()
```

## Graceful Shutdown

```ts
process.on("SIGTERM", async () => {
  await taskora.close() // waits for active jobs to finish
})
```

## Add Retry Logic

Tasks can be configured with retry policies for automatic error recovery.

```ts
const sendEmailTask = taskora.task("send-email", {
  retry: {
    attempts: 3,
    backoff: "exponential",
    delay: 1000,
  },
  handler: async (data: { to: string; subject: string }) => {
    return await mailer.send(data)
  },
})
```

## Full Example

Here's a complete working example:

```ts
import { createTaskora } from "taskora"
import { redisAdapter } from "taskora/redis"

const taskora = createTaskora({
  adapter: redisAdapter("redis://localhost:6379"),
  defaults: {
    retry: { attempts: 3, backoff: "exponential", delay: 1000 },
    timeout: 30_000,
    concurrency: 5,
  },
})

const processImageTask = taskora.task("process-image", {
  timeout: 60_000,
  concurrency: 2,
  handler: async (data: { url: string; width: number }, ctx) => {
    ctx.log.info("Starting image processing", { url: data.url })
    ctx.progress(0)

    const image = await downloadImage(data.url)
    ctx.progress(50)

    const resized = await resize(image, data.width)
    ctx.progress(100)

    return { path: resized.path, size: resized.size }
  },
})

// Dispatch
const handle = processImageTask.dispatch({ url: "https://example.com/photo.jpg", width: 800 })

// Monitor progress
handle.on?.("progress", (p) => console.log(`Progress: ${p}%`))

// Wait for result
const result = await handle.result
console.log("Done:", result.path)

// Start workers
await taskora.start()
```

## Next Steps

- [Core Concepts](/guide/core-concepts) — Understand the mental model
- [Tasks](/guide/tasks) — Task definition patterns & schema validation
- [Retry & Backoff](/features/retry-backoff) — Configure resilient retry strategies
- [Testing](/testing/) — Test your tasks without Redis
