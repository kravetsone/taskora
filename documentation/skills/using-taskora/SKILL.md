---
name: taskora
description: >
  Use when working with taskora, task queues in TypeScript/Node.js,
  background jobs, job scheduling, workflows/pipelines, Redis-backed queues,
  or building distributed task processing systems with taskora.
  Not for BullMQ, Agenda, Bee-Queue, or other task queue libraries.
---

# taskora — Task Queue for Node.js

taskora is a modern, type-safe task queue library for Node.js. TypeScript-first, batteries-included. Unlike BullMQ or Agenda, taskora is **task-centric** (not queue-centric) — you define tasks, not queues. The queue is an implementation detail.

## Architecture overview

```
taskora              — core engine, types, task API (zero DB deps)
taskora/redis        — Redis adapter (peer dep: ioredis)
taskora/memory       — in-memory adapter (zero deps, for testing & dev)
taskora/test         — test runner with virtual time
taskora/board        — admin dashboard (peer dep: hono)
taskora/telemetry    — OpenTelemetry adapter (deferred)
taskora/react        — React hooks (deferred)
```

Always import from the correct subpath:

```typescript
// Core
import { createTaskora, chain, group, chord } from "taskora"
import type { Taskora } from "taskora"

// Redis adapter
import { redisAdapter } from "taskora/redis"

// Testing
import { createTestRunner } from "taskora/test"

// Admin dashboard
import { createBoard } from "taskora/board"
```

`ioredis` is an **optional peer dep** — only required when using `taskora/redis`.

## Basic usage

### Creating an instance

```typescript
import { createTaskora } from "taskora"
import { redisAdapter } from "taskora/redis"

const taskora = createTaskora({
  adapter: redisAdapter("redis://localhost:6379"),
  // or: redisAdapter({ host, port, password })
  // or: redisAdapter(existingIORedisInstance)
  defaults: {
    retry: { attempts: 3, backoff: "exponential", delay: 1000 },
    timeout: 30_000,
    concurrency: 5,
  },
})
```

### Defining tasks

Minimal — name + function:

```typescript
const sendEmailTask = taskora.task(
  "send-email",
  async (data: { to: string; subject: string }) => {
    await mailer.send(data)
    return { messageId: "abc" }
  },
)
// Infers: Task<{ to: string; subject: string }, { messageId: string }>
```

With options:

```typescript
const processImageTask = taskora.task("process-image", {
  retry: { attempts: 5, backoff: "exponential", maxDelay: 60_000 },
  timeout: 120_000,
  concurrency: 10,
  handler: async (data: { url: string; width: number }, ctx) => {
    ctx.progress(50)
    ctx.log.info("Processing", { url: data.url })
    const result = await sharp(data.url).resize(data.width).toBuffer()
    return { size: result.byteLength }
  },
})
```

### Dispatching jobs

```typescript
const handle = sendEmailTask.dispatch({ to: "user@example.com", subject: "Hello" })

handle.id            // job UUID — available synchronously, immediately
await handle         // resolves to job ID string (thenable, backward-compatible)
await handle.result  // waits for actual result: { messageId: "abc" }

await handle.getState()
// "waiting" | "delayed" | "active" | "completed" | "failed" | "retrying" | "cancelled" | "expired"
```

Dispatch options:

```typescript
sendEmailTask.dispatch(data, {
  delay: 5_000,        // delay before processing
  priority: 1,         // higher = processed first
  ttl: "5m",           // expire if not started within 5 minutes
  concurrencyKey: "user:123",  // limit concurrency per key
  concurrencyLimit: 2,
  debounce: { key: "user:123", delay: "2s" },
  throttle: { key: "user:123", max: 3, window: "1m" },
  deduplicate: { key: "sync:123", while: ["waiting", "delayed", "active"] },
})
```

Bulk dispatch:

```typescript
const handles = await sendEmailTask.dispatchMany([
  { data: { to: "a@b.com", subject: "Hi" } },
  { data: { to: "c@d.com", subject: "Hey" }, options: { delay: 5000 } },
])
```

### Starting workers & shutdown

```typescript
await taskora.start()  // starts workers for all registered tasks

process.on("SIGTERM", async () => {
  await taskora.close()  // waits for active jobs to finish, then disconnects
})
```

## Task context (ctx)

Second argument to every handler:

```typescript
const myTask = taskora.task("my-task", {
  handler: async (data: { url: string }, ctx) => {
    ctx.id              // job ID
    ctx.attempt         // current attempt (1-based)
    ctx.signal          // AbortSignal — fires on shutdown or cancellation
    ctx.timestamp       // job creation time (epoch ms)
    ctx.heartbeat()     // extend processing lock
    ctx.progress(50)    // report progress (number or object)
    ctx.log.info("Fetching resource")
    ctx.log.warn("Rate limit approaching", { remaining: 3 })
    ctx.log.error("Unexpected response", { status: 500 })

    // Manual retry with custom delay
    try {
      return await fetchResource(data.url)
    } catch (err) {
      if (isRateLimited(err)) {
        throw ctx.retry({ delay: err.retryAfter * 1000 })
      }
      throw err  // regular error — uses configured retry policy
    }
  },
})
```

## Retry & backoff

```typescript
const apiTask = taskora.task("call-api", {
  retry: {
    attempts: 5,          // total attempts (not retries): 5 = 1 initial + 4 retries
    backoff: "exponential", // "fixed" | "exponential" | "linear" | ((attempt) => ms)
    delay: 1000,          // base delay in ms
    maxDelay: 60_000,     // cap
    jitter: true,         // ±25% randomization (default: true)
    retryOn: [NetworkError, TimeoutError],  // whitelist (if set, only these retry)
    noRetryOn: [ValidationError],           // blacklist
  },
  handler: async (data) => { /* ... */ },
})
```

`TimeoutError` is **not retried by default** — add to `retryOn` explicitly if you want timeout retries.

Manual retry from handler: `throw ctx.retry({ delay: 5000, reason: "rate limited" })` or `throw new RetryError()`.

## Schema validation (Standard Schema)

Any library implementing [Standard Schema](https://standardschema.dev/) works — Zod, Valibot, ArkType, TypeBox.

```typescript
import { z } from "zod"

const createUserTask = taskora.task("create-user", {
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
    return { id: user.id }
  },
})
```

`@standard-schema/spec` is a peer dep (types only). The library never imports Zod/Valibot directly.

## Schema versioning & migrations

Three levels — pick what fits:

### Level 1: Bump version (schema defaults do the work)

```typescript
const sendEmailTask = taskora.task("send-email", {
  version: 2,
  input: z.object({
    to: z.string(),
    subject: z.string(),
    html: z.boolean().default(false),  // old v1 jobs get false via schema
  }),
  handler: async (data) => { /* ... */ },
})
```

### Level 2: Sparse migrate record (only breaking changes)

```typescript
const sendEmailTask = taskora.task("send-email", {
  version: 4,
  input: emailSchemaV4,
  migrate: {
    3: (data) => ({ ...(data as any), body: { text: "" } }),  // only v3→v4 is breaking
  },
  handler: async (data) => { /* ... */ },
})
```

### Level 3: Tuple migrate (strict, typed last element)

```typescript
import { into } from "taskora"

const sendEmailTask = taskora.task("send-email", {
  input: emailSchema,
  migrate: [
    (data) => ({ ...(data as any), body: "" }),          // v1→v2
    into(emailSchema, (data) => ({                       // v2→v3 (return type enforced)
      to: (data as any).to,
      subject: (data as any).subject,
      body: { text: String((data as any).body) },
    })),
  ],
  // version = since + migrate.length = 1 + 2 = 3
  handler: async (data) => { /* ... */ },
})
```

Prune old migrations with `since`:

```typescript
const sendEmailTask = taskora.task("send-email", {
  since: 3,
  migrate: [
    (data) => ({ ...(data as any), priority: "normal" }),  // v3→v4
  ],
  // version = 3 + 1 = 4
  handler: async (data) => { /* ... */ },
})
```

Inspect migration state:

```typescript
const status = await taskora.inspect().migrations("send-email")
// { version, since, queue: { oldest, byVersion }, canBumpSince }
```

## Scheduling / Cron

### Inline schedule

```typescript
const healthCheckTask = taskora.task("health-check", {
  schedule: { every: "30s" },
  handler: async () => await pingServices(),
})
```

### Standalone schedules

```typescript
app.schedule("cleanup", {
  task: processImageTask,
  every: "5m",
  data: { url: "internal://cleanup", width: 0 },
})

app.schedule("daily-report", {
  task: sendEmailTask,
  cron: "0 9 * * MON-FRI",
  timezone: "America/New_York",
  data: { to: "team@company.com", subject: "Daily Report" },
})

app.schedule("invoice-generation", {
  task: generateInvoiceTask,
  cron: "0 0 1 * *",
  onMissed: "catch-up",  // "skip" (default) | "catch-up" | "catch-up-limit:5"
  data: { type: "monthly" },
})
```

Duration type: `number | "${number}s" | "${number}m" | "${number}h" | "${number}d"`.

`cron-parser` is an optional peer dep — only needed if using `cron:` expressions.

### Runtime schedule management

```typescript
await app.schedules.list()
await app.schedules.pause("daily-report")
await app.schedules.resume("daily-report")
await app.schedules.update("cleanup", { every: "10m" })
await app.schedules.remove("cleanup")
await app.schedules.trigger("daily-report")  // fire now, outside schedule
```

Leader election ensures only one scheduler runs across multiple workers (SET NX PX).

## Workflows (Canvas)

Type-safe task composition — chain, group, chord. Inspired by Celery's Canvas.

### Signatures

`.s()` creates a serializable, composable snapshot:

```typescript
const sig = sendEmailTask.s({ to: "a@b.com", subject: "Welcome" })
// Type: Signature<{ to: string; subject: string }, { messageId: string }>
```

| Call | Behavior |
|---|---|
| `task.s(data)` | Bound — data is fixed, ignores pipeline input |
| `task.s()` | Unbound — receives previous step's output |

### Chain — sequential pipeline

```typescript
import { chain } from "taskora"

const onboarding = chain(
  createUserTask.s({ name: "John", email: "john@example.com" }),
  sendWelcomeEmailTask.s(),  // receives { id: string }
  notifySlackTask.s(),       // receives { messageId: string }
)

const handle = onboarding.dispatch()
const result = await handle.result
```

Pipe syntax (unlimited chaining):

```typescript
const result = await createUserTask
  .s({ name: "John", email: "john@example.com" })
  .pipe(sendWelcomeEmailTask.s())
  .pipe(notifySlackTask.s())
  .dispatch()
  .result
```

`chain()` has type overloads for up to 10 steps. `.pipe()` has no limit.

### Group — parallel execution

```typescript
import { group } from "taskora"

const handle = group(
  processImageTask.s({ url: "img1.jpg", width: 800 }),
  processImageTask.s({ url: "img2.jpg", width: 800 }),
  processImageTask.s({ url: "img3.jpg", width: 800 }),
).dispatch()

const result = await handle.result
// Type: [ImageResult, ImageResult, ImageResult]
```

### Chord — parallel then callback

```typescript
import { chord } from "taskora"

const handle = chord(
  [
    fetchPriceTask.s({ symbol: "AAPL" }),
    fetchPriceTask.s({ symbol: "GOOG" }),
  ],
  calculatePortfolioTask.s(),
  // ^ receives [PriceResult, PriceResult]
).dispatch()
```

### Composability

Compositions are themselves valid inputs:

```typescript
const handle = chord(
  [
    chain(fetchDataTask.s({ source: "api" }), transformTask.s()),
    chain(fetchDataTask.s({ source: "db" }), transformTask.s()),
  ],
  mergeTask.s(),
).dispatch()
```

### Map & Chunk

```typescript
const handle = processImageTask.map([
  { url: "img1.jpg", width: 800 },
  { url: "img2.jpg", width: 800 },
])
// Equivalent to group(task.s(item1), task.s(item2), ...).dispatch()

const handle = processImageTask.chunk(largeList, { size: 50 })
// 50 at a time, then next 50
```

### WorkflowHandle

```typescript
const handle = chain(a.s(data), b.s()).dispatch()

await handle                     // ensure dispatched
const result = await handle.result  // wait for final result
const state = await handle.getState()  // "running" | "completed" | "failed" | "cancelled"
await handle.cancel({ reason: "no longer needed" })  // cascade cancel

// Workflow-level TTL
chain(a.s(data), b.s()).dispatch({ ttl: "5m" })
```

## Events

### Task-level

```typescript
sendEmailTask.on("completed", (event) => {
  event.id; event.result; event.duration; event.attempt
})

sendEmailTask.on("failed", (event) => {
  event.id; event.error; event.attempt; event.willRetry
})

sendEmailTask.on("retrying", (event) => {
  event.id; event.attempt; event.nextAttempt; event.error
})

sendEmailTask.on("progress", (event) => {
  event.id; event.progress
})

sendEmailTask.on("active", (event) => {
  event.id; event.attempt
})

sendEmailTask.on("stalled", (event) => {
  event.id; event.count; event.action  // "recovered" | "failed"
})

sendEmailTask.on("cancelled", (event) => {
  event.id; event.reason
})
```

### App-level

```typescript
taskora.on("task:completed", (event) => { /* event includes task name */ })
taskora.on("task:failed", (event) => {})
taskora.on("task:active", (event) => {})
taskora.on("task:stalled", (event) => {})
taskora.on("task:cancelled", (event) => {})
taskora.on("worker:ready", () => {})
taskora.on("worker:error", (error) => {})
taskora.on("worker:closing", () => {})
```

Default error logging: when no `failed` listener is registered, taskora logs to `console.error`. Adding any `failed` listener (app or task level) suppresses the default.

## Middleware

Koa-style onion model:

```typescript
// App-level (before start())
taskora.use(async (ctx, next) => {
  const start = performance.now()
  await next()
  metrics.record(ctx.task.name, performance.now() - start)
})

// Per-task
const protectedTask = taskora.task("admin-action", {
  middleware: [requireRole("admin"), auditLog()],
  handler: async (data) => { /* ... */ },
})
```

Middleware context extends `Taskora.Context` with `task: { name }`, mutable `data`, and mutable `result` (readable after `await next()`).

Execution order: app middleware -> task middleware -> handler.

## Flow control

| Feature | Scope | Excess jobs | Configured on |
|---|---|---|---|
| **debounce** | per-key | replaced (last wins) | dispatch options |
| **throttle** | per-key | dropped | dispatch options |
| **deduplicate** | per-key | no-op (first wins) | dispatch options |
| **ttl** | per-job | expired/failed | dispatch or task |
| **singleton** | per-task | queued (wait) | task definition |
| **concurrencyKey** | per-key | queued (wait) | dispatch options |
| **overlap: false** | per-schedule | skipped | schedule definition |

### Debounce

```typescript
await reindexTask.dispatch({ userId: "123" }, {
  debounce: { key: "user:123", delay: "2s" },
})
```

### Throttle

```typescript
await notifyTask.dispatch({ userId: "123", msg: "New message" }, {
  throttle: { key: "user:123", max: 3, window: "1m" },
})
```

### Deduplicate

```typescript
await syncUserTask.dispatch({ userId: "123" }, {
  deduplicate: { key: "sync:123" },
})
```

### TTL / Expiration

```typescript
// Per-dispatch
await sendOtpTask.dispatch(data, { ttl: "5m" })

// Per-task
const sendOtpTask = taskora.task("send-otp", {
  ttl: { max: "5m", onExpire: "discard" },  // "fail" (default) | "discard"
  handler: async (data) => { /* ... */ },
})
```

### Singleton

```typescript
const rebuildCacheTask = taskora.task("rebuild-cache", {
  singleton: true,  // only one active globally across all workers
  handler: async () => { /* ... */ },
})
```

### Batch collection (collect)

Accumulate items and flush as a batch:

```typescript
const indexTask = taskora.task("index-batch", {
  collect: { key: "search-index", delay: "5s", maxSize: 100, maxWait: "30s" },
  handler: async (items: SearchItem[]) => {
    // items is an array — all accumulated items flushed together
    await searchIndex.bulkIndex(items)
  },
})

// Each dispatch adds one item to the accumulator
await indexTask.dispatch({ id: "1", title: "Hello" })
await indexTask.dispatch({ id: "2", title: "World" })
// After 5s (or 100 items, or 30s) → handler receives [item1, item2, ...]
```

Three flush triggers (whichever comes first): debounce delay, maxSize, maxWait.

## Cancellation

```typescript
const handle = longTask.dispatch(data)

await handle.cancel({ reason: "no longer needed" })
// Waiting/delayed → cancelled immediately
// Active → AbortSignal fires, onCancel hook runs
```

Task-level cancel hook:

```typescript
const importTask = taskora.task("import", {
  onCancel: async (ctx) => {
    // ctx.signal already aborted
    await cleanupPartialImport(ctx.id)
  },
  handler: async (data, ctx) => {
    // ctx.signal.aborted becomes true on cancel
    for (const chunk of chunks) {
      if (ctx.signal.aborted) break
      await processChunk(chunk)
    }
  },
})
```

## Inspector API

```typescript
const inspector = taskora.inspect()

await inspector.active()
await inspector.waiting({ task: "send-email", limit: 50 })
await inspector.delayed()
await inspector.completed()
await inspector.failed()
await inspector.cancelled()
await inspector.expired()

await inspector.stats()
// { waiting, active, delayed, completed, failed, expired, cancelled }

await inspector.stats({ task: "send-email" })

const job = await inspector.find("job-id-123")
// { id, task, state, data, result, error, progress, logs, attempt, version, timeline }

// Type-safe variant
const job = await inspector.find(sendEmailTask, "job-id-123")
job.data    // { to: string; subject: string }
job.result  // { messageId: string } | undefined
```

## Dead letter queue

```typescript
await taskora.deadLetters.list({ task: "send-email", limit: 20 })
await taskora.deadLetters.retry("job-id-123")
await taskora.deadLetters.retryAll({ task: "send-email" })
```

DLQ is a view over the failed sorted set — no separate `:dead` key.

## Retention

ON by default:

```typescript
const taskora = createTaskora({
  adapter: redisAdapter("redis://localhost:6379"),
  retention: {
    completed: { maxAge: "1h", maxItems: 100 },   // defaults
    failed: { maxAge: "7d", maxItems: 300 },       // defaults
  },
})
```

Trim runs piggyback on stall check interval (zero extra timers).

## Stall detection

Workers heartbeat via lock extension. Stalled jobs (no heartbeat) are auto-recovered or failed.

```typescript
const myTask = taskora.task("my-task", {
  stall: { interval: 30_000, maxCount: 1 },
  // maxCount: 1 = re-queue first stall, fail on second
  handler: async (data) => { /* ... */ },
})
```

## Testing

### Test runner

```typescript
import { createTestRunner } from "taskora/test"

const runner = createTestRunner()

// Define tasks on the runner's app
const addTask = runner.app.task("add", async (data: { x: number; y: number }) => data.x + data.y)
```

### From existing instance

```typescript
import { createTestRunner } from "taskora/test"
import { taskora, sendEmailTask } from "../src/tasks"

const runner = createTestRunner({ from: taskora })
// All tasks patched to use in-memory backend — inter-task dispatches work
```

### Two execution modes

**`runner.run(task, data)`** — direct handler call, inline retry loop, no queue:

```typescript
const result = await runner.run(sendEmailTask, { to: "test@example.com", subject: "Test" })
```

**`runner.execute(task, data)`** — full pipeline (dispatch -> process -> retries -> result):

```typescript
const execution = await runner.execute(sendEmailTask, { to: "test@example.com", subject: "Test" })
execution.state     // "completed"
execution.result    // { messageId: "..." }
execution.attempts  // 1
execution.logs      // LogEntry[]
execution.progress  // number | object | null
execution.error     // string | undefined
execution.handle    // ResultHandle
```

### Testing workflows

```typescript
const handle = chain(addTask.s({ x: 3, y: 4 }), doubleTask.s()).dispatch()
await handle

for (let i = 0; i < 10; i++) {
  await runner.processAll()
  if (await handle.getState() === "completed") break
}

const result = await handle.result  // 14
console.log(runner.steps)  // workflow step history
```

### Cleanup

```typescript
afterEach(() => runner.clear())    // standalone mode
afterEach(() => runner.dispose())  // from-instance mode (restores original adapters)
```

## Admin dashboard (Board)

```typescript
import { createBoard } from "taskora/board"

const board = createBoard(taskora, {
  auth: async (req) => { /* return true/false */ },
  readOnly: false,
  basePath: "/admin/taskora",
})

// Standalone
board.listen(3000)

// Or integrate with frameworks
app.use("/admin/taskora", board.fetch)     // Bun.serve / Deno.serve
app.route("/admin/taskora", board.app)     // Hono
```

Features: overview dashboard, task detail, job detail with timeline, workflow DAG visualization, schedule management, DLQ view, global job search, dark/light theme, keyboard shortcuts (1-5 navigation, `/` search).

## Adapters

### Redis adapter

```typescript
import { redisAdapter } from "taskora/redis"

const adapter = redisAdapter("redis://localhost:6379")
// or: redisAdapter({ host, port, password, db, tls })
// or: redisAdapter(existingIORedisInstance)
```

Redis 7.0+ required. All multi-step state transitions use Lua scripts for atomicity. Keys use `{hash tags}` for Redis Cluster compatibility.

Key layout: `taskora:{task}:{key}` — no prefix by default, customizable via `prefix` option.

### Memory adapter

```typescript
import { memoryAdapter } from "taskora/memory"

const adapter = memoryAdapter()
```

Full adapter implementation using plain JS data structures. No Redis needed. Used internally by `taskora/test`.

## Types

All public types under the `Taskora` namespace:

```typescript
import type { Taskora } from "taskora"

type State = Taskora.JobState
type Config = Taskora.RetryConfig
type Ctx = Taskora.Context
type Mid = Taskora.Middleware
type Opts = Taskora.DispatchOptions
type Info = Taskora.JobInfo<MyData, MyResult>
type Stats = Taskora.QueueStats
type Log = Taskora.LogEntry
```

## Conventions

- Factory function: `createTaskora()` — returns App instance
- Task variables: `*Task` suffix — `sendEmailTask`, `processImageTask`
- Task string names: kebab-case — `"send-email"`, `"process-image"`
- Property: `adapter` (not `backend`) — matches `Taskora.Adapter` interface
- All keys for one job share a `{hash tag}` for Redis Cluster compatibility
- `ioredis` is an optional peer dep — install only when using `taskora/redis`

## Common patterns

### Error handling with typed results

```typescript
import { JobFailedError, TimeoutError, CancelledError } from "taskora"

try {
  const result = await handle.result
} catch (err) {
  if (err instanceof CancelledError) { /* job was cancelled */ }
  if (err instanceof TimeoutError) { /* waitFor() timed out */ }
  if (err instanceof JobFailedError) { /* job failed permanently */ }
}
```

### Metrics middleware

```typescript
taskora.use(async (ctx, next) => {
  const start = performance.now()
  try {
    await next()
    metrics.recordSuccess(ctx.task.name, performance.now() - start)
  } catch (err) {
    metrics.recordFailure(ctx.task.name, err)
    throw err
  }
})
```

### Multi-step processing with progress

```typescript
const importTask = taskora.task("import-data", {
  timeout: 300_000,
  handler: async (data: { fileUrl: string }, ctx) => {
    ctx.log.info("Downloading file")
    const file = await download(data.fileUrl, { signal: ctx.signal })
    ctx.progress({ step: "download", percent: 33 })

    ctx.log.info("Parsing records")
    const records = await parse(file)
    ctx.progress({ step: "parse", percent: 66 })

    ctx.log.info("Inserting into database", { count: records.length })
    ctx.heartbeat()  // extend lock for long insert
    await db.bulkInsert(records)
    ctx.progress({ step: "insert", percent: 100 })

    return { imported: records.length }
  },
})
```

### Rate-limited API calls

```typescript
const apiTask = taskora.task("call-external-api", {
  retry: {
    attempts: 5,
    backoff: "exponential",
    delay: 1000,
  },
  handler: async (data: { endpoint: string }, ctx) => {
    try {
      return await fetch(data.endpoint, { signal: ctx.signal }).then(r => r.json())
    } catch (err) {
      if (err.status === 429) {
        throw ctx.retry({ delay: Number(err.headers.get("retry-after")) * 1000 })
      }
      throw err
    }
  },
})
```
