---
name: taskora
description: >
  taskora — TypeScript-first distributed task queue for Node.js with Redis backend.
  Use when building background job systems, scheduling recurring tasks, composing
  type-safe workflows (chain/group/chord), handling retries with backoff, rate
  limiting, debouncing/throttling/deduplicating dispatches, cancelling running jobs,
  validating job schemas, versioning job payloads, inspecting queue state, managing
  dead-letter queues, or running the admin dashboard. Not for BullMQ, Agenda,
  Bee-Queue, or other task queue libraries.
metadata:
  author: Taskora
  version: "0.1.0"
  source: https://github.com/kravetsone/taskora
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

---

## Internal flows

### Job lifecycle state machine

```
dispatch()
    │
    ├──(no delay)──→ WAITING ──→ worker claims ──→ ACTIVE
    │                   │                            │
    └──(delay > 0)──→ DELAYED ─(timer fires)──→ WAITING  │
                                                     │
                        ┌────────────────────────────┤
                        │            │               │              │
                        ▼            ▼               ▼              ▼
                   COMPLETED      FAILED          RETRYING      CANCELLED
                                    │               │
                                    │               ▼
                                    │           DELAYED ──→ WAITING ──→ ACTIVE ...
                                    │
                                (expired job during dequeue)
                                    ▼
                                 EXPIRED
```

State transitions and what triggers them:

| From | To | Trigger |
|---|---|---|
| — | `waiting` | `dispatch()` with no delay |
| — | `delayed` | `dispatch()` with `delay` option |
| `delayed` | `waiting` | Score time reached in sorted set, promoted by `moveToActive.lua` |
| `waiting` | `active` | Worker claims via `blockingDequeue` → `moveToActive.lua` |
| `active` | `completed` | Handler returns successfully → `ack.lua` |
| `active` | `failed` | Handler throws, no retries left → `fail.lua` |
| `active` | `retrying` | Handler throws, retries remaining → `fail.lua` (retry path) |
| `retrying` | `delayed` | `fail.lua` sets ZADD with backoff delay score |
| `active` | `cancelled` | `handle.cancel()` → `cancel.lua` + worker detects via pub/sub or `extendLock` |
| `waiting`/`delayed` | `cancelled` | `handle.cancel()` → `cancel.lua` (immediate) |
| `waiting`/`delayed` | `expired` | TTL exceeded, detected during `moveToActive.lua` promote/dequeue |

Every state transition is a **Lua script** — no partial states, no race conditions.

### Worker processing pipeline

When a worker claims a job, this is the exact sequence:

```
blockingDequeue (BZPOPMIN on marker ZSET)
    │
    ▼
moveToActive.lua
  ├── promote delayed jobs (ZRANGEBYSCORE → LPUSH)
  ├── check TTL expiration (expireAt < now → EXPIRED)
  ├── check singleton (LLEN active > 0 → re-queue with 1s delay)
  ├── check concurrency key limit
  ├── RPOPLPUSH wait → active
  ├── set lock token + processedOn timestamp
  └── return job data
    │
    ▼
Version check
  ├── job._v > task.version → nack (future version, leave for newer worker)
  ├── job._v < task.since → fail permanently ("migration no longer available")
  └── job._v <= task.version → continue
    │
    ▼
Deserialize (serializer.deserialize)
    │
    ▼
Migration (if job._v < task.version)
  └── run migration chain: for each v from job._v to task.version, apply migrate[v] if exists
    │
    ▼
Schema validation (if input schema + versioned task)
  └── standardSchema.validate(data) — applies .default() values
    │
    ▼
Middleware pipeline (composed once at Worker construction)
  └── app middleware → task middleware → handler wrapper
    │
    ▼
Handler execution (with timeout race if configured)
  ├── timeout fires → TimeoutError + controller.abort("timeout")
  └── handler completes → result
    │
    ▼
Output validation (if output schema)
    │
    ▼
Cancel check (signal.aborted && reason === "cancelled"?)
  ├── yes → onCancel hook → finishCancel.lua
  └── no → continue
    │
    ├──(success)──→ ack.lua (LREM active + store result + ZADD completed + XADD event)
    │                  └── advance workflow if part of one
    │
    └──(error)──→ Retry decision:
                    ├── RetryError → always retry (unless attempts exhausted)
                    ├── TimeoutError → NOT retried by default (must be in retryOn)
                    ├── noRetryOn match → permanent fail
                    ├── retryOn set + no match → permanent fail
                    └── else → shouldRetry(attempt < max) → retry or fail
                      │
                      ├── retry → fail.lua (retry path: HINCRBY attempt, state=retrying,
                      │           ZADD delayed with backoff score, XADD retrying event)
                      │
                      └── permanent fail → fail.lua (LREM active + ZADD failed + XADD event)
                                            └── failWorkflow if part of one
```

### Retry decision flow

```
Handler throws error
    │
    ▼
Is error a RetryError (manual ctx.retry())?
  ├── yes → Are attempts exhausted (attempt >= retry.attempts)?
  │           ├── yes → permanent fail
  │           └── no → RETRY with RetryError.delay or computed backoff
  │
  └── no → Is error a TimeoutError?
              ├── yes → Is TimeoutError in retry.retryOn?
              │           ├── yes, and attempt < attempts → RETRY
              │           └── no → permanent fail
              │
              └── no → Is error in retry.noRetryOn?
                          ├── yes → permanent fail
                          └── no → Is retry.retryOn set?
                                    ├── yes → Is error in retryOn?
                                    │           ├── yes, attempt < attempts → RETRY
                                    │           └── no → permanent fail
                                    └── no → attempt < retry.attempts?
                                              ├── yes → RETRY
                                              └── no → permanent fail
```

Backoff delay computation:

```
base = retry.delay (default: 1000ms)
strategy:
  "fixed"       → base
  "linear"      → base * attempt
  "exponential" → base * 2^(attempt-1)  [default]
  function      → fn(attempt)

cap: min(delay, retry.maxDelay)
jitter (default on): delay * random(0.75, 1.25)
```

`retry.attempts` is **total attempts**, not retry count. `attempts: 3` means 1 initial + 2 retries.

### Workflow execution flow

```
dispatch(composition)
    │
    ▼
flattenToDAG(composition)
  └── recursively flatten chain/group/chord into WorkflowGraph:
      { nodes: [{ taskName, data, deps, jobId }], terminal: [indices] }
    │
    ▼
createWorkflow(workflowId, graph)
  └── store entire graph as single Redis hash: taskora:wf:{id}
    │
    ▼
Enqueue root nodes (nodes with deps = [])
  └── each node gets a pre-generated jobId, enqueued as normal job with _wf/_wfNode fields
    │
    ▼
Worker completes node job → ack.lua
    │
    ▼
advanceWorkflow(workflowId, nodeIndex, result)
  └── Lua script:
      1. Mark node as completed, store result
      2. Find nodes whose ALL deps are now completed
      3. For each ready node:
         ├── 1 dep → pass that dep's result as input
         └── N deps → pass array of all dep results as input
      4. Return toDispatch list + whether workflow completed
    │
    ├──(toDispatch not empty)──→ enqueue next batch of nodes
    │
    ├──(completed = true)──→ workflow state = "completed"
    │     └── result = terminal nodes' results (single or array)
    │
    └──(node failed permanently)──→ failWorkflow(workflowId, nodeIndex, error)
          └── Lua script:
              1. Mark workflow as "failed"
              2. Return list of active jobIds
              3. Worker cancels all active/pending nodes (cascade)
```

Data flow through chains: `task.s(data)` = bound (ignores pipeline), `task.s()` = unbound (receives predecessor output). First chain step MUST have bound data.

### Scheduling flow

```
app.schedule() or task schedule option
    │
    ▼
Store config in Redis hash + next run time in sorted set
    │
    ▼
Scheduler loop (runs in ONE leader across all workers):
    │
    ├── acquireSchedulerLock (SET NX PX 30s, token-based)
    │     ├── acquired → I am leader
    │     └── not acquired → skip tick (another leader owns it)
    │
    └── tickScheduler (every pollInterval, default 1s):
          │
          ▼
        TICK_SCHEDULER Lua:
          1. ZRANGEBYSCORE schedules:next (score <= now)
          2. ZREM claimed entries (atomic — first worker wins)
          3. HGET config for each
          4. Return list of due schedules
            │
            ▼
          For each due schedule:
            ├── overlap check: if overlap=false, check lastJobId state
            │     ├── still active → skip this run
            │     └── done/not exists → dispatch
            │
            ├── missed run policy:
            │     ├── "skip" → dispatch once, set next run
            │     ├── "catch-up" → dispatch for each missed interval
            │     └── "catch-up-limit:N" → dispatch up to N missed
            │
            └── dispatch task → update lastJobId + next run time

Leader failover: lock has 30s TTL, renewed every tick. If leader dies,
another worker acquires within ~30s.
```

### Cancellation flow

```
handle.cancel({ reason })
    │
    ▼
cancel.lua:
  ├── job in waiting/delayed/retrying?
  │     └── move to cancelled set immediately → return "cancelled"
  │
  └── job in active?
        └── set cancelledAt flag in hash + PUBLISH to cancel channel
            → return "flagged"
    │
    ▼
Worker detects cancel (two paths, whichever first):
  ├── Redis pub/sub: cancel channel message → controller.abort("cancelled")
  └── extendLock heartbeat: returns "cancelled" → controller.abort("cancelled")
    │
    ▼
Handler observes ctx.signal.aborted = true
  ├── handler checks signal and stops → throws/returns
  └── handler ignores signal → continues until done
    │
    ▼
After handler exits:
  └── worker detects signal.reason === "cancelled"
      └── onCancel hook runs (if defined)
          └── finishCancel.lua: LREM active → ZADD cancelled, clean dedup/concurrency keys
```

### Stall detection flow

```
Every stallInterval (default 30s):
    │
    ▼
stalledCheck.lua (two-phase):
  Phase 1: previousActiveSet ∩ currentActiveSet = stalled candidates
    └── for each candidate: does lock key exist?
          ├── yes → healthy (extendLock already SREMed from stalled set)
          └── no → truly stalled
                ├── stalledCount < maxCount → re-queue (LPUSH wait, state=waiting)
                └── stalledCount >= maxCount → fail permanently

  Phase 2: SADD all currently active IDs for next check cycle
```

### Collect (batch accumulation) flow

```
dispatch(item)
    │
    ▼
COLLECT_PUSH Lua:
  1. RPUSH item to collect:{key}:items list
  2. Count items in list
  3. count >= maxSize?
  │    ├── yes → immediate flush: drain list → create real job in wait set
  │    └── no → update/create flush sentinel (delayed job with collectKey)
  │              └── debounce: each dispatch resets the delay timer
  │
  ▼ (when sentinel fires — delay elapsed without new items)
moveToActive.lua: sentinel job claimed
  └── detects collectKey → drains collect:{key}:items into :data
      └── worker receives items[] as handler data
  │
  ▼ (or maxWait fires — absolute deadline reached)
same as above — maxWait creates a hard deadline independent of debounce
```

Three flush triggers (whichever first): debounce delay reset per dispatch, maxSize immediate flush, maxWait absolute deadline.

---

## Best practices

### Production checklist

```typescript
const taskora = createTaskora({
  adapter: redisAdapter({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null,      // required for blocking commands
    enableReadyCheck: false,         // faster startup
    lazyConnect: true,               // connect on first use
  }),
  defaults: {
    retry: { attempts: 3, backoff: "exponential", delay: 1000, maxDelay: 60_000 },
    timeout: 30_000,
    concurrency: 5,
  },
  retention: {
    completed: { maxAge: "24h", maxItems: 1_000 },
    failed: { maxAge: "30d", maxItems: 5_000 },
  },
})
```

### Always set timeouts

Every task should have a timeout. Without one, a stuck handler holds the lock forever (until stall detection kicks in at 30s intervals).

```typescript
// Bad — no timeout, stuck handler blocks the slot
const task = taskora.task("risky", {
  handler: async (data) => await externalApi.call(data),
})

// Good — timeout + signal propagation
const task = taskora.task("risky", {
  timeout: 30_000,
  handler: async (data, ctx) => {
    return await externalApi.call(data, { signal: ctx.signal })
  },
})
```

### Propagate ctx.signal to all I/O

The AbortSignal fires on shutdown AND cancellation. Pass it to every `fetch`, database call, or child process to ensure clean abort.

```typescript
handler: async (data, ctx) => {
  const response = await fetch(url, { signal: ctx.signal })
  await db.query(sql, { signal: ctx.signal })
  const result = await childProcess.exec(cmd, { signal: ctx.signal })
}
```

### Use ctx.heartbeat() for long operations

Lock TTL is 30s, extended every 10s automatically. But if a single operation takes >30s (e.g., large file upload), extend the lock manually:

```typescript
handler: async (data, ctx) => {
  for (const chunk of largeFile.chunks()) {
    ctx.heartbeat()  // extend lock
    await uploadChunk(chunk)
  }
}
```

### Idempotent handlers

Jobs can be delivered more than once (network partitions, stall recovery, lock expiry). Design handlers to be idempotent.

```typescript
// Bad — double-charge if job retried after ack failure
handler: async (data) => {
  await chargeCustomer(data.customerId, data.amount)
}

// Good — idempotency key prevents double processing
handler: async (data, ctx) => {
  await chargeCustomer(data.customerId, data.amount, {
    idempotencyKey: ctx.id,  // job ID is stable across retries
  })
}
```

### Choose the right flow control

| Need | Use | Why |
|---|---|---|
| Only process the latest update | `debounce` | Replaces previous job, last dispatch wins |
| Limit rate per user/key | `throttle` | Drops excess, per-key |
| Don't queue duplicate work | `deduplicate` | No-op if existing job matches |
| Limit rate for the whole task | `concurrency` | Queue excess, per-worker |
| Only one active globally | `singleton: true` | Queue excess, global across workers |
| Limit concurrent per group | `concurrencyKey + concurrencyLimit` | Queue excess, per-key |
| Job is useless after timeout | `ttl` | Expires before processing starts |
| Accumulate items then batch | `collect` | Flushes on debounce/size/maxWait |

### Retry anti-patterns

```typescript
// Bad — retrying non-transient errors wastes resources
const task = taskora.task("validate", {
  retry: { attempts: 5, backoff: "exponential" },
  handler: async (data) => {
    // ValidationError will be retried 5 times for nothing
    if (!data.email.includes("@")) throw new ValidationError("bad email")
  },
})

// Good — exclude non-transient errors
const task = taskora.task("validate", {
  retry: {
    attempts: 5,
    backoff: "exponential",
    noRetryOn: [ValidationError, AuthError, NotFoundError],
  },
  handler: async (data) => { /* ... */ },
})
```

### Structure task definitions consistently

```typescript
// Recommended pattern for production tasks
const processOrderTask = taskora.task("process-order", {
  // Schema validation
  input: orderSchema,
  output: orderResultSchema,

  // Resilience
  retry: { attempts: 3, backoff: "exponential", noRetryOn: [ValidationError] },
  timeout: 60_000,

  // Concurrency
  concurrency: 10,

  // Versioning (bump when schema changes)
  version: 2,
  migrate: {
    1: (data) => ({ ...(data as any), priority: "normal" }),
  },

  // Middleware
  middleware: [auditLog(), validatePermissions()],

  // Handler
  handler: async (data, ctx) => {
    ctx.log.info("Processing order", { orderId: data.id })
    ctx.progress(0)
    // ... process
    ctx.progress(100)
    return { status: "completed", processedAt: Date.now() }
  },

  // Cancellation cleanup
  onCancel: async (data, ctx) => {
    await rollbackPartialOrder(ctx.id)
  },
})
```

### Testing strategy

```typescript
// Unit test: handler logic only (fast, no queue)
it("processes order correctly", async () => {
  const result = await runner.run(processOrderTask, validOrderData)
  expect(result.status).toBe("completed")
})

// Integration test: full pipeline with retries
it("retries on transient error then succeeds", async () => {
  let calls = 0
  const flaky = runner.app.task("flaky", {
    retry: { attempts: 3 },
    handler: async () => {
      calls++
      if (calls < 3) throw new Error("transient")
      return "ok"
    },
  })

  const exec = await runner.execute(flaky, {})
  expect(exec.state).toBe("completed")
  expect(exec.attempts).toBe(3)
})

// Workflow test
it("chain passes data between steps", async () => {
  const handle = chain(addTask.s({ x: 1, y: 2 }), doubleTask.s()).dispatch()
  await handle
  while (await handle.getState() !== "completed") {
    await runner.processAll()
  }
  expect(await handle.result).toBe(6)
})
```

### Graceful shutdown

```typescript
// Handle both SIGTERM (orchestrator stop) and SIGINT (Ctrl+C)
const signals = ["SIGTERM", "SIGINT"] as const
let shuttingDown = false

for (const signal of signals) {
  process.on(signal, async () => {
    if (shuttingDown) return  // prevent double-shutdown
    shuttingDown = true
    console.log(`Received ${signal}, shutting down...`)
    await taskora.close()  // waits for active jobs, then disconnects
    process.exit(0)
  })
}

await taskora.start()
```

### Monitoring with events

```typescript
// Global error tracking
taskora.on("task:failed", (event) => {
  errorTracker.captureException(new Error(event.error), {
    tags: { task: event.task, jobId: event.id, attempt: event.attempt },
  })
})

// Metrics
taskora.on("task:completed", (event) => {
  metrics.histogram("task.duration", event.duration, { task: event.task })
})

taskora.on("task:stalled", (event) => {
  alerting.warn(`Job ${event.id} stalled (${event.action})`, { task: event.task })
})
```

### When to use workflows vs standalone dispatch

```typescript
// Standalone: steps are independent, don't need result passing
await sendEmailTask.dispatch(emailData)
await logAnalyticsTask.dispatch(analyticsData)

// Chain: output of step N is input of step N+1
const handle = chain(
  createUserTask.s(userData),
  sendWelcomeEmailTask.s(),   // needs user ID from previous step
  notifySlackTask.s(),        // needs email result
).dispatch()

// Group: independent steps that should complete together
const handle = group(
  resizeSmall.s(imgData),
  resizeMedium.s(imgData),
  resizeLarge.s(imgData),
).dispatch()

// Chord: parallel work, then aggregate
const handle = chord(
  [fetchA.s(), fetchB.s(), fetchC.s()],
  merge.s(),  // receives [resultA, resultB, resultC]
).dispatch()
```

---

## Further reading

Full taskora documentation in LLM-friendly formats (regenerated on every docs build, always matches the current version):

- **Single-file full docs**: `https://kravetsone.github.io/taskora/llms-full.txt` — entire documentation concatenated, paste into context when you need the exhaustive reference
- **Index**: `https://kravetsone.github.io/taskora/llms.txt` — table of contents with descriptions, use to decide which page to fetch
- **Per-page markdown**: append `.md` to any doc URL (e.g. `https://kravetsone.github.io/taskora/features/workflows.md`)

Prefer this SKILL.md for day-to-day work (it's the curated quick reference). Fall back to `llms-full.txt` when you need deeper detail on a specific subsystem not covered here (e.g. full inspector API surface, board internals, specific recipe walkthroughs).
