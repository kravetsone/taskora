# taskora — API Design

> The task queue Node.js deserves. Type-safe, composable, batteries-included.

## Philosophy

1. **Task-centric, not queue-centric** — You define tasks, not queues. The queue is an implementation detail.
2. **Progressive disclosure** — `task.dispatch(data)` is enough to start. Workflows, retries, cron, monitoring unlock as you need them.
3. **Everything is composable** — Tasks produce signatures. Signatures compose into chains, groups, and chords. Compositions are themselves signatures.
4. **Type safety is DX** — If the types compile, the runtime works. No magic strings. No producer/consumer type drift.

---

## 1. App

One entry point. One connection config. Done.

```typescript
import { createApp } from "taskora"

const app = createApp({
  // String URL, options object, or IORedis instance
  connection: "redis://localhost:6379",

  // Defaults inherited by every task (overridable per-task)
  defaults: {
    retry: { max: 3, backoff: "exponential" },
    timeout: 30_000,
  },
})
```

---

## 2. Task Definition

### Minimal — name + function

```typescript
const sendEmail = app.task("send-email", async (data: { to: string; subject: string }) => {
  await mailer.send(data)
  return { messageId: "abc" }
})
// Infers: Task<{ to: string; subject: string }, { messageId: string }>
```

### With options

```typescript
const processImage = app.task("process-image", {
  retry: { max: 5, backoff: "exponential", maxDelay: 60_000 },
  timeout: 120_000,
  concurrency: 10,
  rateLimit: { max: 100, per: "1m" },

  handler: async (data: { url: string; width: number }) => {
    const result = await sharp(data.url).resize(data.width).toBuffer()
    return { size: result.byteLength }
  },
})
```

### With Standard Schema validation

Any schema library implementing [Standard Schema](https://standardschema.dev/) works — Zod, Valibot, ArkType, TypeBox, or custom schemas. Zero adapter code.

```typescript
import { z } from "zod"
// or: import * as v from "valibot"
// or: import { type } from "arktype"

const createUser = app.task("create-user", {
  input: z.object({
    name: z.string().min(1),
    email: z.string().email(),
  }),
  output: z.object({
    id: z.string().uuid(),
  }),

  handler: async (data) => {
    // data is { name: string; email: string } — inferred from schema
    const user = await db.users.create(data)
    return { id: user.id } // validated against output schema at runtime
  },
})
```

**How it works internally:**

```typescript
import type { StandardSchemaV1 } from "@standard-schema/spec"

interface TaskOptions<TInput, TOutput> {
  input?: StandardSchemaV1<TInput>
  output?: StandardSchemaV1<TOutput>
  handler: (data: TInput, ctx: TaskContext) => Promise<TOutput> | TOutput
}
```

When `input` is provided, `dispatch()` validates data through the schema's `~standard.validate()` before enqueuing. When `output` is provided, the handler's return value is validated before marking the job complete. Both use the same universal `StandardSchemaV1` interface — the library never imports Zod, Valibot, or anything else.

---

## 3. Calling Tasks

### Simple dispatch

```typescript
await sendEmail.dispatch({ to: "user@example.com", subject: "Hello" })
//                         ^ type-checked against task input
```

### With execution options

```typescript
await sendEmail.dispatch(
  { to: "user@example.com", subject: "Hello" },
  {
    delay: 5_000,
    priority: 1,
    deduplicate: "email-user@example.com",
  },
)
```

### Result handle

`dispatch()` returns a **thenable handle** — await it for the result, or use methods for inspection.

```typescript
const handle = sendEmail.dispatch({ to: "user@example.com", subject: "Hello" })

handle.id            // job ID — available synchronously, immediately
await handle         // resolves to { messageId: "abc" }

await handle.getState()
// "waiting" | "delayed" | "active" | "completed" | "failed" | "retrying"

handle.onProgress((progress) => {
  console.log(`${progress.percent}% — ${progress.message}`)
})

await handle.waitFor(5_000) // throws if not done in 5s
```

### Bulk dispatch

```typescript
const handles = await sendEmail.dispatchMany([
  { data: { to: "a@b.com", subject: "Hi" } },
  { data: { to: "c@d.com", subject: "Hey" }, options: { delay: 5000 } },
])
```

---

## 4. Task Context

Second argument to every handler. Typed, powerful, no magic.

```typescript
const resilientTask = app.task("resilient", {
  retry: { max: 5, backoff: "exponential" },

  handler: async (data: { url: string }, ctx) => {
    ctx.id              // job ID
    ctx.attempt         // current attempt (1-based)
    ctx.signal          // AbortSignal — for graceful shutdown
    ctx.timestamp       // when job was created

    // Progress
    ctx.progress(50)
    ctx.progress({ step: "uploading", percent: 75 })

    // Structured logging (attached to this job, queryable later)
    ctx.log.info("Fetching resource")
    ctx.log.warn("Rate limit approaching", { remaining: 3 })

    // Heartbeat — extend lock, signal "I'm still alive"
    ctx.heartbeat()

    // Manual retry with control
    try {
      return await fetchResource(data.url)
    } catch (err) {
      if (isRateLimited(err)) {
        throw ctx.retry({ delay: err.retryAfter * 1000 })
      }
      throw err // regular error — uses configured retry policy
    }
  },
})
```

### Context API surface

| Property/Method | Type | Description |
|---|---|---|
| `ctx.id` | `string` | Job ID |
| `ctx.attempt` | `number` | Current attempt (1-based) |
| `ctx.signal` | `AbortSignal` | Fires on graceful shutdown |
| `ctx.timestamp` | `number` | Job creation time (epoch ms) |
| `ctx.progress(value)` | `void` | Report progress (number or object) |
| `ctx.log.info/warn/error(msg, meta?)` | `void` | Structured log attached to job |
| `ctx.heartbeat()` | `void` | Extend processing lock |
| `ctx.retry(options?)` | `Error` | Throw to trigger manual retry |

---

## 5. Scheduling / Cron

### Inline schedule

```typescript
const healthCheck = app.task("health-check", {
  schedule: { every: "30s" },
  handler: async () => {
    return await pingServices()
  },
})
```

### Standalone schedules

```typescript
// Interval with human-readable durations
app.schedule("cleanup", {
  task: processImage,
  every: "5m",
  data: { url: "internal://cleanup", width: 0 },
})

// Cron expression with timezone
app.schedule("daily-report", {
  task: sendEmail,
  cron: "0 9 * * MON-FRI",
  timezone: "America/New_York",
  data: { to: "team@company.com", subject: "Daily Report" },
})

// Missed run policy (BullMQ silently drops missed runs!)
app.schedule("invoice-generation", {
  task: generateInvoice,
  cron: "0 0 1 * *",
  onMissed: "catch-up",        // "skip" | "catch-up" | "catch-up-limit:5"
  data: { type: "monthly" },
})
```

### Runtime management

```typescript
const schedules = await app.schedules.list()

await app.schedules.pause("daily-report")
await app.schedules.resume("daily-report")
await app.schedules.update("cleanup", { every: "10m" })
await app.schedules.remove("cleanup")
await app.schedules.trigger("daily-report")   // fire now, outside schedule
```

---

## 6. Workflows (Canvas)

Inspired by Celery's Canvas. Type-safe composition of tasks into complex pipelines.

> **Implementation priority:** Phase 2. Core task engine ships first.

### Signatures — the building block

`.s()` creates a **Signature** — a serializable, composable snapshot of a task invocation.

```typescript
const sig = sendEmail.s({ to: "a@b.com", subject: "Welcome" })
// Type: Signature<{ to: string; subject: string }, { messageId: string }>

await sig.dispatch()
```

### Chain — sequential pipeline

Each task's output flows as input to the next. **TypeScript checks the entire chain at compile time.**

```typescript
import { chain } from "taskora"

const onboarding = chain(
  createUser.s({ name: "John", email: "john@example.com" }),
  // ^ returns { id: string }
  sendWelcomeEmail.s(),
  // ^ receives { id: string }, returns { messageId: string }
  notifySlack.s(),
  // ^ receives { messageId: string }
)

await onboarding.dispatch()
```

Pipe syntax (alternative):

```typescript
const result = await createUser
  .s({ name: "John", email: "john@example.com" })
  .pipe(sendWelcomeEmail.s())
  .pipe(notifySlack.s())
  .dispatch()
```

### Group — parallel execution

```typescript
import { group } from "taskora"

const result = await group(
  processImage.s({ url: "img1.jpg", width: 800 }),
  processImage.s({ url: "img2.jpg", width: 800 }),
  processImage.s({ url: "img3.jpg", width: 800 }),
).dispatch()
// Type: [{ size: number }, { size: number }, { size: number }]
```

### Chord — parallel then callback

```typescript
import { chord } from "taskora"

await chord(
  // Header: all run in parallel
  [
    fetchPrice.s({ symbol: "AAPL" }),
    fetchPrice.s({ symbol: "GOOG" }),
    fetchPrice.s({ symbol: "MSFT" }),
  ],
  // Callback: receives array of all results
  calculateTotal.s(),
).dispatch()
```

### Map & Chunk — batch operations

```typescript
await processImage.map([
  { url: "img1.jpg", width: 800 },
  { url: "img2.jpg", width: 800 },
  { url: "img3.jpg", width: 800 },
])

await processImage.chunk(largeImageList, { size: 50 })
```

### Composability — workflows are signatures

```typescript
const complexWorkflow = chord(
  [
    chain(fetchData.s({ source: "api" }), transform.s()),
    chain(fetchData.s({ source: "db" }), transform.s()),
  ],
  merge.s(),
)
```

---

## 7. Events & Monitoring

### Task-level events

```typescript
sendEmail.on("completed", (event) => {
  event.id          // job ID
  event.result      // typed: { messageId: string }
  event.duration    // ms
  event.attempt     // which attempt succeeded
})

sendEmail.on("failed", (event) => {
  event.id
  event.error       // Error object
  event.attempt
  event.willRetry   // boolean — is there a next attempt?
})

sendEmail.on("retrying", (event) => {
  event.id
  event.attempt
  event.nextAttempt // when the retry is scheduled
  event.error
})

sendEmail.on("progress", (event) => {
  event.id
  event.progress    // whatever ctx.progress() received
})
```

### App-level events

```typescript
app.on("task:active", (event) => {})
app.on("task:completed", (event) => {})
app.on("task:failed", (event) => {})
app.on("worker:ready", () => {})
app.on("worker:error", (error) => {})
app.on("worker:closing", () => {})
```

---

## 8. Inspector API

Query actual state, not just events. The debugging experience BullMQ never gave us.

```typescript
const inspector = app.inspect()

// What's running right now?
const active = await inspector.active()
// [{ id, task: "send-email", data: {...}, startedAt, worker }]

// What's waiting?
const waiting = await inspector.waiting({ task: "send-email", limit: 50 })

// What's scheduled?
const delayed = await inspector.delayed()

// Stats
const stats = await inspector.stats()
// { processed: 15420, failed: 23, active: 5, waiting: 142, delayed: 7 }

// Find a specific job by ID
const job = await inspector.find("job-id-123")
job.state       // "active"
job.data        // input data
job.result      // if completed
job.error       // if failed
job.logs        // structured logs from ctx.log
job.timeline    // [{ state: "waiting", at: ... }, { state: "active", at: ... }]

// Type-safe find (pass the task for typed data/result)
const job = await inspector.find(sendEmail, "job-id-123")
job.data        // { to: string; subject: string }
job.result      // { messageId: string } | undefined
```

---

## 9. Middleware

Koa-style composable middleware for cross-cutting concerns.

```typescript
// App-level
app.use(async (ctx, next) => {
  const start = performance.now()
  try {
    await next()
    metrics.recordSuccess(ctx.task.name, performance.now() - start)
  } catch (err) {
    metrics.recordFailure(ctx.task.name, err)
    throw err
  }
})

// Per-task
const protectedTask = app.task("admin-action", {
  middleware: [requireRole("admin"), auditLog()],
  handler: async (data) => { /* ... */ },
})
```

---

## 10. Retries & Error Handling

### Declarative retries

```typescript
const apiTask = app.task("call-api", {
  retry: {
    max: 5,
    backoff: "exponential",   // 1s, 2s, 4s, 8s, 16s
    maxDelay: 60_000,         // cap at 1 minute
    jitter: true,             // prevent thundering herd
    retryOn: [NetworkError, TimeoutError],
    noRetryOn: [ValidationError, AuthError],
  },
  handler: async (data) => { /* ... */ },
})
```

### Error callbacks

```typescript
await sendEmail.dispatch(
  { to: "user@example.com", subject: "Hi" },
  { onError: alertAdmin.s() },
)
```

### Dead letter queue

```typescript
const app = createApp({
  connection: "redis://localhost:6379",
  deadLetterQueue: {
    enabled: true,
    maxAge: "7d",
  },
})

const dead = await app.deadLetters.list({ task: "send-email", limit: 20 })
await app.deadLetters.retry("job-id-123")
await app.deadLetters.retryAll({ task: "send-email" })
```

---

## 11. Lifecycle

```typescript
// Start processing all defined tasks
await app.start()

// With automatic signal handling
await app.start({ signals: ["SIGTERM", "SIGINT"] })

// Graceful shutdown — waits for active jobs
await app.close({ timeout: 30_000 })
```

---

## 12. Architecture

```
┌─────────────────────────────────────────────────────┐
│                    User Code                         │
│   app.task() / .dispatch() / .schedule() / ...       │
├─────────────────────────────────────────────────────┤
│                  Core Engine                         │
│   ┌───────────┐  ┌──────────┐  ┌────────────────┐   │
│   │ Scheduler │  │ Executor │  │   Workflow      │   │
│   │ (cron)    │  │ (worker) │  │ (chain/group)   │   │
│   └─────┬─────┘  └────┬─────┘  └───────┬────────┘   │
│         │             │                │             │
│   ┌─────┴─────────────┴────────────────┴──────────┐  │
│   │             Backend Interface                  │  │
│   │   enqueue() dequeue() ack() schedule()         │  │
│   │   getState() getResult() subscribe()           │  │
│   └──────────────────┬─────────────────────────────┘  │
├──────────────────────┼───────────────────────────────┤
│   ┌──────────────────┴─────────────────────────────┐  │
│   │         Redis Backend (default)                 │  │
│   │   ioredis + Lua scripts for atomicity           │  │
│   └─────────────────────────────────────────────────┘  │
│   ┌─────────────────────────────────────────────────┐  │
│   │         PostgreSQL Backend (future)              │  │
│   │   SKIP LOCKED for reliable dequeue               │  │
│   └─────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### Backend interface (abstract adapter)

```typescript
interface Backend {
  // Job lifecycle
  enqueue(task: string, data: unknown, options: JobOptions): Promise<string>
  enqueueBulk(jobs: EnqueueJob[]): Promise<string[]>
  dequeue(task: string, count: number): Promise<RawJob[]>
  ack(jobId: string, result: unknown): Promise<void>
  fail(jobId: string, error: Error, retry?: RetryInfo): Promise<void>
  heartbeat(jobId: string, ttl: number): Promise<void>

  // State
  getJob(jobId: string): Promise<RawJob | null>
  getState(jobId: string): Promise<JobState>
  getResult(jobId: string): Promise<unknown>
  listJobs(filter: JobFilter): Promise<RawJob[]>
  getStats(task?: string): Promise<Stats>

  // Scheduling
  addSchedule(name: string, config: ScheduleConfig): Promise<void>
  removeSchedule(name: string): Promise<void>
  listSchedules(): Promise<ScheduleInfo[]>
  getDueSchedules(now: number): Promise<ScheduleInfo[]>

  // Events
  subscribe(pattern: string, handler: EventHandler): Promise<Unsubscribe>
  publish(event: string, payload: unknown): Promise<void>

  // Lifecycle
  connect(): Promise<void>
  disconnect(): Promise<void>
}
```

Any backend that implements this interface works. Redis is first. PostgreSQL is next. Custom backends are possible.

---

## Comparison

| Feature | BullMQ | Celery | **taskora** |
|---|---|---|---|
| Define a task | 3 classes (Queue + Worker + QueueEvents) | `@app.task` decorator | `app.task(name, handler)` |
| Type safety | Manual generics, magic strings | None (Python) | Full inference, compile-time checked |
| Schema validation | None | Pydantic (v5.5+) | Standard Schema (any library) |
| Call a task | `queue.add(name, data)` | `task.delay()` / `apply_async()` | `task.dispatch(data, options?)` |
| Get result | Manual QueueEvents + fetch | `AsyncResult` | Thenable `ResultHandle` |
| Workflows | FlowProducer (parent-child only) | Canvas (chain/group/chord) | Canvas-inspired + TypeScript types |
| Cron | Deprecated RepeatableJobs | Beat (separate process) | Built-in `app.schedule()` + runtime mgmt |
| Missed cron runs | Silently dropped | Backend-dependent | Configurable policy |
| Retries | Automatic only, limited control | `self.retry()` + `autoretry_for` | Both manual (`ctx.retry()`) and declarative |
| Middleware | None | Signals (limited) | Koa-style composable |
| Monitoring | QueueEvents (jobId only) | Flower + events | Inspector API + typed events + job logs |
| Task context | Raw `Job` object | `self.request` | Typed `ctx` with progress/retry/signal |
| Connection setup | Per-instance, different rules | App-level | App-level, one config |
| Backend | Redis only | Multiple brokers | Abstract adapter (Redis, Postgres, ...) |
| Dead letter queue | Manual | Built-in | Built-in with retry API |
