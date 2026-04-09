# taskora — API Design

> The task queue Node.js deserves. Type-safe, composable, batteries-included.

## Philosophy

1. **Task-centric, not queue-centric** — You define tasks, not queues. The queue is an implementation detail.
2. **Progressive disclosure** — `task.dispatch(data)` is enough to start. Workflows, retries, cron, monitoring unlock as you need them.
3. **Everything is composable** — Tasks produce signatures. Signatures compose into chains, groups, and chords. Compositions are themselves signatures.
4. **Type safety is DX** — If the types compile, the runtime works. No magic strings. No producer/consumer type drift.

---

## 1. App

One entry point. Backend is an explicit adapter — no magic `connection` strings.

```typescript
import { taskora } from "taskora"
import { redisAdapter } from "taskora/redis"
// future: import { postgres } from "taskora/postgres"

const app = taskora({
  backend: redisAdapter("redis://localhost:6379"),
  // or: redisAdapter({ host: "localhost", port: 6379 })
  // or: redisAdapter(existingIORedisInstance)

  // Defaults inherited by every task (overridable per-task)
  defaults: {
    retry: { max: 3, backoff: "exponential" },
    timeout: 30_000,
  },
})
```

### Backend as abstract adapter

Each backend is a separate entrypoint — the core `taskora` package never imports `ioredis` or `pg` directly:

```
taskora          — core engine, types, task API (no DB deps)
taskora/redis    — Redis adapter (depends on ioredis)
taskora/postgres — PostgreSQL adapter (future, depends on pg)
```

```typescript
// taskora/redis exports:
import type { Taskora } from "taskora"

export function redisAdapter(
  connection: string | RedisOptions | IORedis,
): Taskora.Adapter
```

This means:
- `ioredis` is a **peer dependency** of `taskora`, not a direct dep
- Users only install what they use
- CJS and ESM both work via `exports` map in `package.json`

```jsonc
// package.json exports
{
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    },
    "./redis": {
      "import": "./dist/redis.mjs",
      "require": "./dist/redis.cjs",
      "types": "./dist/redis.d.ts"
    }
  }
}
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
import type { Taskora } from "taskora"

// All public types live under the Taskora namespace
namespace Taskora {
  interface TaskOptions<TInput, TOutput> {
    input?: StandardSchemaV1<TInput>
    output?: StandardSchemaV1<TOutput>
    handler: (data: TInput, ctx: Taskora.Context) => Promise<TOutput> | TOutput
  }
}
```

When `input` is provided, `dispatch()` validates data through the schema's `~standard.validate()` before enqueuing. When `output` is provided, the handler's return value is validated before marking the job complete. Both use the same universal `StandardSchemaV1` interface — the library never imports Zod, Valibot, or anything else.

---

## 2.1. Schema Versioning & Migrations

Schemas evolve. Jobs already in the queue don't. We need to handle the gap.

### The problem

1. Queue has 10k jobs with `{ to: string, subject: string }`
2. You deploy new code: schema is now `{ to: string, subject: string, html: boolean }`
3. Worker picks up old job → validation fails

### Three levels of laziness

| Situation | What you write |
|---|---|
| Added a field with `.default()` | `version: N` — schema handles it |
| Breaking change among non-breaking ones | `version: N` + `migrate: { K: fn }` (sparse record) |
| Want full type-safe migration chain | `migrate: [fn, fn, fn]` (tuple, version derived) |

### Level 1: Just bump `version` (schema defaults do the work)

When you add a field with `.default()`, the schema validation fills it in automatically. No migration function needed — just tell us the version changed:

```typescript
// v1 — started simple
const sendEmail = app.task("send-email", {
  input: z.object({
    to: z.string(),
    subject: z.string(),
  }),
  handler: async (data) => { /* ... */ },
})

// v2 — added a field with default. Just bump version.
const sendEmail = app.task("send-email", {
  version: 2,
  input: z.object({
    to: z.string(),
    subject: z.string(),
    html: z.boolean().default(false), // old jobs get false via schema
  }),
  handler: async (data) => { /* ... */ },
})

// v3 — another field with default. Bump again.
const sendEmail = app.task("send-email", {
  version: 3,
  input: z.object({
    to: z.string(),
    subject: z.string(),
    html: z.boolean().default(false),
    priority: z.enum(["low", "normal", "high"]).default("normal"),
  }),
  // still no migrate! schema defaults handle v1→v3 automatically
  handler: async (data) => { /* ... */ },
})
```

### Level 2: Sparse `migrate` record (only for breaking changes)

When most version bumps are additive (schema defaults) but one is breaking, use a record — only define the functions you need:

```typescript
// v4 — body changed from string to object. Can't use .default() for this.
const sendEmail = app.task("send-email", {
  version: 4,
  input: z.object({
    to: z.string(),
    subject: z.string(),
    html: z.boolean().default(false),
    priority: z.enum(["low", "normal", "high"]).default("normal"),
    body: z.object({ text: z.string(), html: z.string().optional() }),
  }),
  migrate: {
    // Only v3→v4 needs a function. v1→v2 and v2→v3 handled by schema defaults.
    3: (data) => ({ ...(data as any), body: { text: "" } }),
  },
  handler: async (data) => { /* ... */ },
})
```

### Level 3: Tuple `migrate` (strict mode, typed last element)

When you want TypeScript to enforce the entire migration chain. Version is derived automatically: `version = since + migrate.length`.

```typescript
const sendEmail = app.task("send-email", {
  input: z.object({
    to: z.string(),
    subject: z.string(),
    body: z.object({ text: z.string(), html: z.string().optional() }),
  }),

  migrate: [
    // v1 → v2: added body as string
    (data) => ({ ...(data as any), body: "" }),
    // v2 → v3: body became an object (last — return type enforced by TS)
    (data) => ({
      to: (data as any).to,
      subject: (data as any).subject,
      body: { text: String((data as any).body) },
    }),
  ],
  // version = 1 + 2 = 3

  handler: async (data) => {
    // data is ALWAYS v3 — guaranteed by types and runtime
  },
})
```

**Type enforcement on last migration:**

```typescript
type TupleMigrations<TInput> = readonly [
  ...((data: unknown) => unknown)[],   // any number of intermediate
  (data: unknown) => TInput,           // last one — return type enforced
]
```

TypeScript infers `TInput` from the `input` schema, then checks the last tuple element returns that type.

**Problem: `as any` casts defeat inference.** Solution — `into()` helper:

```typescript
import { into } from "taskora"

migrate: [
  (data) => ({ ...(data as any), body: "" }),
  // into() locks the return type to the schema
  into(emailSchema, (data) => ({
    to: (data as any).to,
    subject: (data as any).subject,
    body: { text: String((data as any).body) },
  })),
],
```

```typescript
// Implementation — trivial, the value is in the types
function into<S extends StandardSchemaV1>(
  schema: S,
  fn: (data: unknown) => InferInput<S>,
): (data: unknown) => InferInput<S> {
  return fn
}
```

### Version resolution

```
If migrate is a tuple:   version = since + migrate.length
If migrate is a record:  version = explicit (required)
If migrate is omitted:   version = explicit (required) or 1
```

### Processing flow

```
DISPATCH (producer):                DEQUEUE (worker):
    │                                    │
    ▼                                    ▼
validate(schema)                  read { data, _v: 1 }
    │                                    │
    ▼                                    ▼
store { data, _v }                _v > version?
    │                               → nack, leave in queue (future worker)
    ▼                              _v < since?
  Redis ──────────────────►         → reject (expired migration)
                                   _v < version?
                                    → for each step v → v+1:
                                        migrate[v] exists? run it
                                        no migrate[v]? skip (schema handles it)
                                        │
                                        ▼
                                   validate(schema)  ← .default() applied here
                                        │
                                        ▼
                                    handler(data)
```

Worker internals:

```typescript
function processJob(task: TaskDefinition, raw: RawJob) {
  let data = raw.data
  let v = raw._v ?? 1

  // Future job — leave for newer worker
  if (v > task.version) {
    return backend.nack(raw.id)
  }

  // Too old — no migrations available
  if (v < task.since) {
    return backend.reject(raw.id, {
      reason: "schema-too-old",
      jobVersion: v,
      minimumVersion: task.since,
    })
  }

  // Run migration chain (sparse — skip versions without a function)
  const migrations = normalizeMigrations(task) // tuple or record → unified lookup
  while (v < task.version) {
    const fn = migrations[v]
    if (fn) data = fn(data)
    // no fn? that's fine — schema validation will apply .default() values
    v++
  }

  // Validate — this is where .default() fills in missing fields
  if (task.input) {
    const result = task.input["~standard"].validate(data)
    if (result.issues) throw new ValidationError(result.issues)
    data = result.value
  }

  return task.handler(data, createContext(raw))
}
```

### Job version handling

| Condition | Action |
|---|---|
| `job._v === version` | Validate → handler (fast path) |
| `job._v < version && job._v >= since` | Run migrations (skip gaps) → validate → handler |
| `job._v < since` | Reject — migration no longer available |
| `job._v > version` | Nack — leave in queue for newer worker |

### Pruning old migrations with `since`

Migrations accumulate. Remove old ones by bumping `since`:

**Tuple form — before** (4 migrations, since: 1):
```typescript
// since: 1 (default)
migrate: [
  (data) => ({ ...(data as any), body: "" }),              // v1→v2
  (data) => ({ ...(data as any), subject: data.title }),   // v2→v3
  (data) => ({ ...(data as any), priority: "normal" }),    // v3→v4
  (data): Email => ({ ... }),                              // v4→v5
],
// version = 1 + 4 = 5
```

**Tuple form — after** (removed first 2, since: 3):
```typescript
since: 3,
migrate: [
  (data) => ({ ...(data as any), priority: "normal" }),    // v3→v4
  (data): Email => ({ ... }),                              // v4→v5
],
// version = 3 + 2 = 5 (same!)
```

**Record form** — just delete keys:
```typescript
since: 3,
version: 5,
migrate: {
  // deleted keys 1 and 2
  3: (data) => ({ ...(data as any), priority: "normal" }),
},
```

### Migration inspection API

Check when it's safe to prune:

```typescript
const status = await app.inspect().migrations("send-email")
// {
//   version: 5,
//   since: 1,
//   migrations: 4,
//   queue: {
//     oldest: 3,
//     byVersion: { 3: 12, 4: 45, 5: 1230 },
//   },
//   scheduled: {
//     oldest: 5,
//   },
//   canBumpSince: 3,   // safe to remove migrations before v3
// }
```

### Internal typing

```typescript
import type { StandardSchemaV1 } from "@standard-schema/spec"

export namespace Taskora {
  export type InferInput<S> = S extends StandardSchemaV1<infer I> ? I : never

  export interface TaskOptions<
    TInput,
    TOutput,
    TSchema extends StandardSchemaV1<TInput> = StandardSchemaV1<TInput>,
  > {
    input?: TSchema
    output?: StandardSchemaV1<TOutput>

    since?: number  // default: 1
    version?: number // required for record migrate or no-migrate mode

    // Two forms:
    // Tuple — strict, last element typed, version derived
    // Record — sparse, only breaking changes, version explicit
    migrate?:
      | readonly [...((data: unknown) => unknown)[], (data: unknown) => TInput]
      | Record<number, (data: unknown) => unknown>

    handler: (data: TInput, ctx: Taskora.Context) => Promise<TOutput> | TOutput
  }
}
```

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

### Default error logging

When a task handler throws and **no** `failed` listener is registered (neither `task.on("failed")` nor `app.on("task:failed")`), taskora logs the error to `console.error` automatically:

```
[taskora] task "send-email" job a1b2c3d4 failed (attempt 1/3, will retry)
Error: Connection refused
    at handler (/app/tasks/email.ts:15:11)
    at Array.handlerMw (/app/node_modules/taskora/src/worker.ts:82:36)
    ...
```

This fires synchronously on the worker that processed the job — no Redis round-trip, full stack trace preserved.

The default logger is **automatically suppressed** the moment you register your own `failed` listener:

```typescript
// Default logging stops as soon as you add this:
app.on("task:failed", (event) => {
  myLogger.error({ task: event.task, jobId: event.id, error: event.error })
})
```

Per-task listeners also suppress it for that specific task:

```typescript
sendEmail.on("failed", (event) => { /* ... */ })
// Default logger no longer fires for send-email, but still fires for other tasks
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

### Retention & dead letter queue

```typescript
// Retention is ON by default — no config needed for safe prod behavior
// Defaults: completed { maxAge: "1h", maxItems: 100 }, failed { maxAge: "7d", maxItems: 300 }
// Override if needed:
const app = taskora({
  adapter: redisAdapter("redis://localhost:6379"),
  retention: {
    completed: { maxAge: "24h", maxItems: 1_000 },
    failed: { maxAge: "30d", maxItems: 5_000 },
  },
})

// DLQ management — retry failed jobs
const dead = await app.deadLetters.list({ task: "send-email", limit: 20 })
await app.deadLetters.retry("job-id-123")
await app.deadLetters.retryAll({ task: "send-email" })
```

---

## 11. Flow Control

### Debounce

Multiple dispatches within a window → only the **last** one runs. Timer resets on each dispatch.

Use case: reindex search after rapid edits, invalidate cache after burst of updates.

```typescript
const reindex = app.task("reindex-user", {
  handler: async (data: { userId: string }) => {
    await searchIndex.rebuild(data.userId)
  },
})

// User edits profile 5 times in 2 seconds — only the last dispatch runs
await reindex.dispatch({ userId: "123" }, {
  debounce: { key: "user:123", delay: "2s" },
})
```

Under the hood: each dispatch with the same key **replaces** the previous delayed job. The delay restarts from zero.

```
dispatch(key="user:123")  →  [delayed 2s]
dispatch(key="user:123")  →  prev cancelled, [delayed 2s] ← timer restarted
dispatch(key="user:123")  →  prev cancelled, [delayed 2s] ← timer restarted
                              ... 2s passes ...
                              → runs once with last data
```

### Throttle

At most N executions per key per time window. Extra dispatches are **dropped** (not queued).

Use case: limit API calls per customer, prevent notification spam.

```typescript
const notify = app.task("send-notification", {
  handler: async (data: { userId: string; msg: string }) => {
    await push.send(data)
  },
})

await notify.dispatch({ userId: "123", msg: "New message" }, {
  throttle: { key: "user:123", max: 3, window: "1m" },
})
// 4th dispatch within 1 minute → silently dropped, returns null handle
```

Different from task-level `rateLimit`: throttle is **per-key** and drops excess jobs. `rateLimit` is **per-task** and delays excess jobs.

| | `rateLimit` | `throttle` |
|---|---|---|
| Scope | per-task (all jobs) | per-key (e.g. per user) |
| Excess jobs | queued, processed later | **dropped** |
| Configured on | task definition | dispatch call |

### Deduplication

Only one job with this key can exist in the queue at a time. Second dispatch is a no-op.

Use case: "sync user data" — no point queuing 10 identical syncs.

```typescript
await syncUser.dispatch({ userId: "123" }, {
  deduplicate: { key: "sync:123" },
})

// Already in queue? → no-op, returns handle to existing job
await syncUser.dispatch({ userId: "123" }, {
  deduplicate: { key: "sync:123" },
})
```

Options:

```typescript
deduplicate: {
  key: "sync:123",
  // Which states count as "existing"?
  while: ["waiting", "delayed", "active"],  // default: all three
  // OR: only deduplicate while waiting (allow re-dispatch once active)
  while: ["waiting", "delayed"],
}
```

### TTL / Expiration

Job expires if not **started** within a time window. Stale jobs are pointless.

Use case: time-sensitive notifications, real-time data processing.

```typescript
await sendOTP.dispatch({ phone: "+1234567890", code: "4821" }, {
  ttl: "5m", // useless if not processed within 5 minutes
})
```

Expired jobs move to `failed` with `ExpiredError` (or silently removed — configurable):

```typescript
const sendOTP = app.task("send-otp", {
  ttl: { max: "5m", onExpire: "discard" }, // "fail" (default) | "discard"
  handler: async (data) => { /* ... */ },
})
```

### Singleton

Only one job of this task can be **active** at a time. Others wait in queue.

Use case: database migrations, global cache rebuild, report generation.

```typescript
const rebuildCache = app.task("rebuild-cache", {
  singleton: true, // only one active at a time, others wait their turn
  handler: async () => {
    await cache.rebuildAll()
  },
})
```

Different from `concurrency: 1` — singleton is **global** across all workers. `concurrency: 1` is per-worker.

### Concurrency per key

Process multiple jobs simultaneously, but limit concurrency per logical group.

Use case: 10 jobs total, but max 1 per user (don't overwhelm one user's API).

```typescript
const syncRepo = app.task("sync-repo", {
  concurrency: 10,  // 10 jobs total across workers
  handler: async (data: { orgId: string; repoId: string }) => {
    await github.sync(data.repoId)
  },
})

await syncRepo.dispatch({ orgId: "acme", repoId: "api" }, {
  concurrencyKey: "org:acme",  // max 1 active job per org
  concurrencyLimit: 2,         // actually, allow 2 per org
})
```

### Cron overlap prevention

If the previous scheduled run hasn't finished → skip this one.

Use case: report that takes 10 minutes on a 5-minute schedule — don't stack them.

```typescript
app.schedule("heavy-report", {
  task: generateReport,
  every: "5m",
  overlap: false,  // skip if previous run is still active (default: false)
})
```

### Summary

| Feature | Scope | Excess jobs | Configured on |
|---|---|---|---|
| **debounce** | per-key | replaced (last wins) | dispatch options |
| **throttle** | per-key | dropped | dispatch options |
| **deduplicate** | per-key | no-op (first wins) | dispatch options |
| **rateLimit** | per-task | delayed | task definition |
| **ttl** | per-job | expired/failed | dispatch or task |
| **singleton** | per-task | queued (wait) | task definition |
| **concurrencyKey** | per-key | queued (wait) | dispatch options |
| **overlap: false** | per-schedule | skipped | schedule definition |
| **collect** | per-key | accumulated → handler gets `T[]` | task definition |

### Collect — debounce with accumulation

Like debounce, but instead of keeping only the last dispatch, **collects all data** into a buffer and passes the entire array to the handler.

```typescript
const processVotes = app.task("process-votes", {
  collect: {
    key: (data) => data.pollId,   // group by poll
    delay: "30s",                  // 30s after LAST dispatch
    maxSize: 1000,                 // or flush when 1000 items collected
    maxWait: "5m",                 // or flush 5m after first item (anti-infinite-debounce)
  },

  // handler receives ARRAY of all accumulated data
  handler: async (items, ctx) => {
    // items: { pollId: string, choice: string, userId: string }[]
    ctx.log.info(`Processing ${items.length} votes`)
    await db.polls.bulkUpdateVotes(items)
  },
})

// Users vote — each dispatch adds to the buffer:
await processVotes.dispatch({ pollId: "poll-1", choice: "A", userId: "u1" })
await processVotes.dispatch({ pollId: "poll-1", choice: "B", userId: "u2" })
await processVotes.dispatch({ pollId: "poll-1", choice: "A", userId: "u3" })
// ... 30s silence ...
// → handler([ {choice:"A"}, {choice:"B"}, {choice:"A"} ]) — one call, three votes
```

Three flush triggers (whichever fires first):

| Trigger | Option | When |
|---|---|---|
| Debounce | `delay: "30s"` | 30s since last dispatch |
| Max size | `maxSize: 1000` | Collected 1000 items |
| Max wait | `maxWait: "5m"` | 5m since first item |

```
dispatch(choice=A)  →  buffer: [A]           timer: [===30s===]
dispatch(choice=B)  →  buffer: [A, B]        timer: [===30s===] ← reset
dispatch(choice=A)  →  buffer: [A, B, A]     timer: [===30s===] ← reset
                       ... 30s silence ...
                       → handler([A, B, A])  — single invocation
```

**Typing:** when `collect` is set, handler receives `TInput[]` instead of `TInput`. `dispatch()` still takes a single `TInput`.

```typescript
// Overloads on app.task():
interface App {
  // Without collect — handler(data: TInput, ctx)
  task<I, O>(name: string, opts: TaskOptions<I, O>): Task<I, O>
  // With collect — handler(items: TInput[], ctx)
  task<I, O>(name: string, opts: CollectTaskOptions<I, O>): CollectTask<I, O>
}
```

**If handler fails** — the entire batch retries as one job (items already in a regular job's `:data` key). No data loss.

**Real-world examples:**

```typescript
// Batch webhook delivery — one HTTP call instead of 100
const deliverWebhooks = app.task("webhooks", {
  collect: { key: (d) => d.endpoint, delay: "5s", maxSize: 100 },
  handler: async (events) => {
    await fetch(events[0].endpoint, {
      method: "POST",
      body: JSON.stringify({ events }),
    })
  },
})

// Search reindex — collect all changed doc IDs
const reindex = app.task("reindex", {
  collect: { key: (d) => d.index, delay: "10s", maxSize: 500, maxWait: "1m" },
  handler: async (items) => {
    const ids = [...new Set(items.map(i => i.docId))]
    await searchEngine.reindexBatch(items[0].index, ids)
  },
})

// Analytics — bulk insert
const trackEvents = app.task("analytics", {
  collect: { key: "default", delay: "5s", maxSize: 10_000, maxWait: "30s" },
  serializer: msgpack(),
  handler: async (events) => {
    await clickhouse.insert("events", events)
  },
})
```

**Peek API** — read the current buffer without draining it. Essential for live-context use cases where unflushed items need to be surfaced in a read path (e.g. chat ingestion: the Q&A path wants to include messages that haven't been extracted into long-term memory yet).

```typescript
interface Task<TInput, TOutput> {
  // Non-destructive read. Returns deserialized items in dispatch order.
  // Throws on non-collect tasks (silent [] would mask config bugs).
  // Returns [] for: empty buffer, just-flushed, never-dispatched.
  peekCollect(collectKey: string): Promise<TInput[]>

  // Stats-only view — one HGETALL, cheaper than peekCollect.
  // Returns null when no active buffer exists for the key.
  inspectCollect(collectKey: string): Promise<Taskora.CollectBufferInfo | null>
}

interface CollectBufferInfo {
  count: number      // items currently buffered
  oldestAt: number   // epoch ms of first dispatch in current buffer
  newestAt: number   // epoch ms of most recent dispatch
}
```

Semantics: single-command atomic snapshot (Redis `LRANGE` / memory `slice`); the buffer-vs-handler ownership boundary is preserved — once `moveToActive` drains the items into the job, peek returns `[]` and inspect returns `null`. No `retain` knob is offered — once items are drained, they belong to the handler's output storage, not the buffer.

---

## 12. Lifecycle

```typescript
// Start processing all defined tasks
await app.start()

// With automatic signal handling
await app.start({ signals: ["SIGTERM", "SIGINT"] })

// Graceful shutdown — waits for active jobs
await app.close({ timeout: 30_000 })
```

---

## 13. Serialization

### Pluggable serializer

Default is JSON (zero deps, debuggable in Redis CLI). Swap to MessagePack/CBOR for smaller payloads and faster parsing.

```typescript
import { taskora } from "taskora"
import { redisAdapter } from "taskora/redis"
import { msgpack } from "taskora/serializers/msgpack"

const app = taskora({
  backend: redisAdapter("redis://localhost:6379"),
  serializer: msgpack(), // default: json()
})

// Or per-task for heavy payloads:
const processImages = app.task("process-images", {
  serializer: msgpack(),
  handler: async (data) => { /* ... */ },
})
```

### Serializer interface

```typescript
export namespace Taskora {
  export interface Serializer {
    serialize(value: unknown): string | Buffer
    deserialize(raw: string | Buffer): unknown
  }
}
```

### Built-in serializers

```
taskora                         — json() included, zero deps
taskora/serializers/msgpack     — peer dep: @msgpack/msgpack
taskora/serializers/cbor        — peer dep: cbor-x
```

| Serializer | Size vs JSON | Parse speed | Debuggable | Deps |
|---|---|---|---|---|
| `json()` | 1x (baseline) | 1x | yes (Redis CLI) | 0 |
| `msgpack()` | **0.5-0.7x** | **1.5-2x faster** | no (binary) | @msgpack/msgpack |
| `cbor()` | 0.5-0.7x | 1.3x faster | no (binary) | cbor-x |

### Split storage for memory efficiency

Job data is split across Redis keys to keep the metadata hash in **ziplist encoding** (3-4x less overhead than hashtable):

```
{taskora:app:send-email:42}           — Hash (ziplist, ~150B overhead)
  "ts"       "1712345678901"             metadata stays small
  "delay"    "5000"                      all values < 64 bytes
  "priority" "1"                         → Redis uses ziplist encoding
  "attempt"  "1"
  "_v"       "3"

{taskora:app:send-email:42}:data      — String: serialized input payload
{taskora:app:send-email:42}:result    — String: serialized output (after complete)
```

The `{...}` hash tag ensures all keys for one job land in the same Redis Cluster slot.

This costs +56 bytes per extra key but saves ~40% total memory vs storing everything in one hash (which forces hashtable encoding when any value exceeds 64 bytes).

All reads/writes happen inside Lua scripts — accessing 3 keys costs the same as 1 (server-side, in-memory, zero extra RTT).

---

## 14. Graceful Cancellation

Distinct `"cancelled"` state. Not failed — cancelled.

```typescript
const handle = longTask.dispatch({ url: "https://example.com/huge.csv" })

// Cancel from outside
await handle.cancel({ reason: "User requested" })

await handle.getState() // "cancelled" — NOT "failed"
```

### Cancel hook

```typescript
const importTask = app.task("import-csv", {
  onCancel: async (data, ctx) => {
    // Cleanup partial results
    await db.deletePartialImport(data.importId)
    await storage.delete(data.tempFile)
  },

  handler: async (data, ctx) => {
    for (const chunk of chunks) {
      ctx.signal.throwIfAborted() // AbortSignal fires on cancel
      await processChunk(chunk)
    }
  },
})
```

### Cascade cancellation

Cancelling a workflow cancels all pending steps:

```typescript
const workflow = chain(
  fetchData.s({ url: "..." }),
  transform.s(),
  upload.s(),
)

const handle = await workflow.dispatch()
await handle.cancel() // fetchData active → cancelled, transform & upload waiting → cancelled
```

---

## 15. Test Utilities

`taskora/test` — in-memory runner, time control, zero Redis.

```typescript
import { createTestRunner } from "taskora/test"

const runner = createTestRunner()

test("processes job correctly", async () => {
  const result = await runner.run(sendEmail, {
    to: "a@b.com",
    subject: "Hi",
  })
  expect(result).toEqual({ messageId: expect.any(String) })
})

test("delayed job", async () => {
  const handle = await runner.dispatch(sendEmail, data, { delay: "5m" })
  expect(await handle.getState()).toBe("delayed")

  runner.advanceTime("5m")

  expect(await handle.getState()).toBe("completed")
})

test("collect accumulation", async () => {
  await runner.dispatch(processVotes, { pollId: "1", choice: "A" })
  await runner.dispatch(processVotes, { pollId: "1", choice: "B" })
  await runner.dispatch(processVotes, { pollId: "1", choice: "C" })

  runner.advanceTime("30s") // trigger flush

  // handler received array of 3 votes
  expect(runner.lastHandlerInput).toHaveLength(3)
})

test("retry behavior", async () => {
  let attempts = 0
  const flaky = app.task("flaky", {
    retry: { max: 3, backoff: "fixed" },
    handler: async () => {
      attempts++
      if (attempts < 3) throw new Error("not yet")
      return { ok: true }
    },
  })

  const result = await runner.run(flaky, {})
  expect(result).toEqual({ ok: true })
  expect(attempts).toBe(3)
})
```

### Runner API

| Method | Description |
|---|---|
| `runner.run(task, data)` | Execute synchronously, return result |
| `runner.dispatch(task, data, opts?)` | Enqueue in memory, return handle |
| `runner.advanceTime(duration)` | Fast-forward delayed jobs and schedules |
| `runner.flush(task, key?)` | Trigger collect flush manually |
| `runner.jobs` | List all jobs with current states |
| `runner.clear()` | Reset all state between tests |

---

## 16. OpenTelemetry

Built-in, not a plugin. Automatic spans with context propagation from producer → consumer → steps.

```typescript
import { otel } from "taskora/telemetry"

const app = taskora({
  backend: redisAdapter("redis://localhost:6379"),
  telemetry: otel({ serviceName: "my-workers" }),
})
```

Automatic trace:

```
HTTP POST /api/orders
  └─ taskora.dispatch(process-order)         [2ms]
      └─ taskora.process(process-order)      [670ms]
          ├─ step(charge-card)               [200ms]
          ├─ step(reserve-shipping)          [350ms]
          └─ step(send-confirmation)         [120ms]
```

Span attributes: `taskora.task`, `taskora.job_id`, `taskora.attempt`, `taskora.version`.

---

## 17. Realtime Frontend Hooks

Stream job progress to UI. Framework-agnostic SSE + React hook.

```typescript
// Backend: any HTTP framework
import { createJobStream } from "taskora/stream"

app.get("/api/jobs/:id/stream", (req, res) => {
  createJobStream(app, req.params.id).pipe(res) // SSE
})
```

```tsx
// Frontend: React
import { useJobStatus } from "taskora/react"

function ExportProgress({ jobId }: { jobId: string }) {
  const { state, progress, result } = useJobStatus(jobId)

  if (state === "completed") return <Download url={result.fileUrl} />

  return <ProgressBar value={progress} label={state} />
}
```

---

## 18. Architecture

```
┌──────────────────────────────────────────────────────┐
│                     User Code                         │
│  import { taskora } from "taskora"                    │
│  import { redisAdapter } from "taskora/redis"                │
│  const app = taskora({ backend: redisAdapter("...") }) │
├──────────────────────────────────────────────────────┤
│                   Core Engine                         │
│  taskora                                              │
│  ┌───────────┐  ┌──────────┐  ┌────────────────┐     │
│  │ Scheduler │  │ Executor │  │   Workflow      │     │
│  │ (cron)    │  │ (worker) │  │ (chain/group)   │     │
│  └─────┬─────┘  └────┬─────┘  └───────┬────────┘     │
│        │             │                │               │
│  ┌─────┴─────────────┴────────────────┴────────────┐  │
│  │           Taskora.Adapter interface              │  │
│  │  enqueue() dequeue() ack() schedule()            │  │
│  │  getState() getResult() subscribe()              │  │
│  └──────────────────┬──────────────────────────────┘  │
├─────────────────────┼────────────────────────────────┤
│  ┌──────────────────┴──────────────────────────────┐  │
│  │  taskora/redis          taskora/postgres         │  │
│  │  ioredis + Lua          pg + SKIP LOCKED         │  │
│  │  scripts                (future)                 │  │
│  └─────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

### Package structure

```
taskora              — core engine, types, task API (zero DB dependencies)
taskora/redis        — Redis adapter (peer dep: ioredis)
taskora/postgres     — PostgreSQL adapter (future, peer dep: pg)
```

Each adapter is a separate entrypoint. The core never imports `ioredis` or `pg` directly. Users install only what they need.

### Adapter interface

```typescript
// Exported from "taskora" under the Taskora namespace
export namespace Taskora {
  export interface Adapter {
    // Job lifecycle
    enqueue(task: string, data: unknown, options: Taskora.JobOptions): Promise<string>
    enqueueBulk(jobs: Taskora.EnqueueJob[]): Promise<string[]>
    dequeue(task: string, count: number): Promise<Taskora.RawJob[]>
    ack(jobId: string, result: unknown): Promise<void>
    fail(jobId: string, error: Error, retry?: Taskora.RetryInfo): Promise<void>
    nack(jobId: string): Promise<void>
    reject(jobId: string, reason: Taskora.RejectReason): Promise<void>
    heartbeat(jobId: string, ttl: number): Promise<void>

    // State
    getJob(jobId: string): Promise<Taskora.RawJob | null>
    getState(jobId: string): Promise<Taskora.JobState>
    getResult(jobId: string): Promise<unknown>
    listJobs(filter: Taskora.JobFilter): Promise<Taskora.RawJob[]>
    getStats(task?: string): Promise<Taskora.Stats>

    // Scheduling
    addSchedule(name: string, config: Taskora.ScheduleConfig): Promise<void>
    removeSchedule(name: string): Promise<void>
    listSchedules(): Promise<Taskora.ScheduleInfo[]>
    getDueSchedules(now: number): Promise<Taskora.ScheduleInfo[]>

    // Events
    subscribe(pattern: string, handler: Taskora.EventHandler): Promise<Taskora.Unsubscribe>
    publish(event: string, payload: unknown): Promise<void>

    // Lifecycle
    connect(): Promise<void>
    disconnect(): Promise<void>
  }
}
```

```typescript
// taskora/redis — adapter factory
import type { Taskora } from "taskora"
import type { Redis, RedisOptions } from "ioredis"

export function redisAdapter(
  connection: string | RedisOptions | Redis,
  options?: { prefix?: string },
): Taskora.Adapter
```

### `Taskora` namespace overview

All public types live under one namespace — no collisions with user code:

```typescript
import { taskora, type Taskora } from "taskora"

namespace Taskora {
  // Core
  interface Adapter { ... }             // what adapters implement
  interface Context { ... }             // ctx in handlers
  interface TaskOptions<I, O> { ... }   // app.task() options

  // Jobs
  interface JobOptions { ... }          // dispatch options (delay, priority, deduplicate)
  interface RawJob { ... }              // internal job representation
  type JobState = "waiting" | "delayed" | "active" | "completed" | "failed" | "retrying"

  // Schema
  type InferInput<S> = ...              // extract input type from schema
  type InferOutput<S> = ...             // extract output type from schema

  // Scheduling
  interface ScheduleConfig { ... }
  interface ScheduleInfo { ... }

  // Events
  interface EventHandler { ... }
  type Unsubscribe = () => void

  // Inspection
  interface Stats { ... }
  interface JobFilter { ... }
  interface MigrationStatus { ... }

  // Errors
  interface RejectReason { ... }
  interface RetryInfo { ... }
}
```

Adapter authors: `import type { Taskora } from "taskora"` — one import, full access.
App developers: types are inferred, namespace rarely needed directly.

---

## 19. Contracts — Producer/Consumer Split

### Problem

Inline `app.task("name", { handler, input, output })` ties declaration and implementation together in a single call. Any process that wants to `dispatch()` must import the handler file — and the handler's transitive dependency graph leaks into the caller's bundle. For a monolith this is fine; for production setups that split API servers from background workers, it's a leak.

Concretely:
- Web API server wants to dispatch `send-email`; it ends up bundling `nodemailer` and `handlebars` even though it never calls them.
- Edge function wants to dispatch `process-image`; it can't, because `sharp` has native bindings and won't build for the edge.
- Three services dispatch to one worker pool; each service duplicates the input/output types manually and drifts.

### Design

A **task contract** is a pure, serializable declaration:

```ts
const sendEmailTask = defineTask({
  name: "send-email",
  input: z.object({ to: z.email(), subject: z.string() }),
  output: z.object({ messageId: z.string() }),
  retry: { attempts: 3, backoff: "exponential" },
  timeout: "30s",
})
```

`defineTask()` returns a `TaskContract<TInput, TOutput>` — plain data with no runtime dependency on `App`, `Worker`, or `Adapter`. Types flow through the object phantom-style so TS inference works without a runtime brand.

Contracts are bound to an `App` in one of two directions:

- **`app.register(contract)`** → returns `BoundTask<I, O>`. Producer path: no handler, dispatch works, worker loop is skipped for this task. Idempotent by task name.
- **`app.implement(contract, handler, options?)`** → returns `BoundTask<I, O>`. Worker path: attaches a handler. Three overloads: bare handler, handler+options, object form (required for collect tasks).

Both return the same `BoundTask` type. The underlying `Task` instance is shared — calling `implement()` after `register()` upgrades the existing task in place, and the `BoundTask` reference returned by `register()` stays valid.

### Design decisions and the roads not taken

**Why explicit `register()` instead of auto-binding on dispatch.**

The Trigger.dev / Inngest pattern is "contract IS dispatchable, auto-resolves at call time". Rejected because:
1. It requires module-level state (which App is "the" App?) or a magic context lookup.
2. It makes errors non-local: if a contract is dispatched without being bound to any app, the error surfaces far from where it was introduced.
3. It complicates tests — swapping a test app for a prod app requires either mocking the module-level binding or passing the app through every call.

Explicit `register()` costs one line per contract. In exchange: no global state, no magic, the type system enforces that a contract must be bound before dispatch.

**Why no `TaskContract.s()` for workflow composition.**

Workflow `Signature` objects currently carry a reference back to the `Task` instance — the dispatcher needs this to extract the adapter and serializer. Adding `.s()` directly on `TaskContract` would require either carrying an App reference on the contract (mutable data, no longer pure) or using module-level state at dispatch time. Neither fits the "contracts are pure data" principle.

The workaround is trivial: `BoundTask.s()` works identically to `Task.s()`, so users `register()` or `implement()` their contracts once and compose workflows from the returned `BoundTask`s:

```ts
const fetchUser = taskora.register(fetchUserContract)
const sendEmail = taskora.register(sendEmailContract)

await chain(fetchUser.s({ id: "42" }), sendEmail.s()).dispatch()
```

**Why `register()` is idempotent, not strict.**

The obvious rule is "calling register() twice for the same name is a bug". Rejected because the monolith case (both producer and worker in one process) naturally calls `register()` and `implement()` on the same contract, sometimes from different modules. An idempotent `register()` makes the intermediate state valid — the first call creates the task, the second returns the existing `BoundTask`, and `implement()` upgrades in place.

The only real conflict is double-`implement()` (two handlers for the same task), which *is* a bug and throws.

**Why `staticContract<I, O>()` as a distinct primitive.**

Producers running on edge runtimes or in browser bundles can't afford to ship Zod/Valibot at runtime. `staticContract<I, O>({ name })` carries the types purely at the type level — no schemas, no runtime validation on the producer. Workers always validate through their own schemas (attached at `implement()` time), so the safety net stays intact at the worker boundary.

A single codebase can have the contract file re-exported in two flavors: `contracts/tasks.ts` with `defineTask()` for Node consumers, and `contracts/tasks.edge.ts` with `staticContract()` for edge/browser. Same task names, same type shapes, different runtime payloads.

### Distribution patterns

The contract file needs to be importable by both producer and worker. Two recommended strategies:

1. **Single package, two entrypoints** — one `package.json`, `src/contracts/tasks.ts` imported by `src/api/` and `src/worker/`, built into two bundles, deployed as two containers from the same Docker image. Friction 1/5. Default recommendation for small-to-mid teams.

2. **Monorepo with `workspace:*` protocol** — bun/pnpm workspaces. `packages/contracts` exports the contract module, `apps/api` and `apps/worker` depend on `"@acme/contracts": "workspace:*"`. No publish step, no private registry. Friction 2/5 initial, 1/5 ongoing. Use when three or more consumers share the same contracts.

Private npm registries (GitHub Packages, Verdaccio, JSR), git submodules, TS path aliases, code generation, and copy-paste are all explicitly documented as anti-patterns. Not because they don't work, but because they add friction without adding safety.

### Runtime drift safety — no new mechanisms needed

The phase was initially planned to include a Redis-backed contract registry (workers publish their implemented contracts on startup, producers verify on dispatch). This was cut. Rationale:

- **Worker-side schema validation** (Phase 1) already validates every job before the handler. A producer dispatching stale data fails at the worker boundary with a clear `ValidationError`.
- **Payload versioning & migrations** (Phase 9) let contracts evolve without requiring atomic deploys: ship worker first with migration chain, ship producer with new shape, in-flight jobs drain correctly.

Together these two mechanisms cover the drift cases that a runtime registry would have caught, without introducing a new moving part. The contract design explicitly declines to add anything the existing primitives already handle.

### `validateOnDispatch` knob

`TaskoraOptions.validateOnDispatch?: boolean` (default `true`) controls whether `dispatch()` validates input against the task's Standard Schema before enqueueing. `DispatchOptions.skipValidation?: boolean` overrides per-call. Threaded through `TaskDeps.validateOnDispatch` into `Task.dispatch()`.

Disable when:
- The producer has already validated upstream (tRPC router, REST framework body parser).
- The producer uses `staticContract()` and has no schema to run.
- Validation cost is measured as a bottleneck.

Worker-side validation is unaffected — it always runs before the handler.

### What's exported

```ts
import {
  defineTask,           // factory for contracts with runtime schemas
  staticContract,       // factory for type-only contracts (no runtime deps)
  isTaskContract,       // runtime type guard
  BoundTask,            // class, instanceof-checkable
  type TaskContract,    // the contract type
  type DefineTaskConfig,
  type StaticContractConfig,
} from "taskora"

// Also exposed as Taskora.TaskContract<I, O> inside the namespace for consistency
import type { Taskora } from "taskora"
type Foo = Taskora.TaskContract<{ a: number }, { b: string }>
```

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
| Connection setup | Per-instance, different rules | App-level | `taskora/redis` adapter — explicit, typed |
| Backend | Redis only | Multiple brokers | Abstract adapter: `taskora/redis`, `taskora/postgres`, ... |
| Dead letter queue | Manual | Built-in | Built-in with retry API |
| Schema versioning | None | None | Built-in migrations with type-safe chain |
| Migration pruning | N/A | N/A | `since` + inspector to check safety |
| Debounce | None | None | Per-key, last dispatch wins |
| Throttle | None | `rate_limit` decorator | Per-key, drop excess |
| Deduplication | Manual (jobId) | None | Per-key with configurable states |
| Job TTL | None | `expires` on apply_async | Built-in with fail/discard policy |
| Singleton | None | None | Global across workers |
| Serialization | JSON only | JSON/pickle/msgpack/yaml | Pluggable (json/msgpack/cbor) |
| Cancellation | No distinct state (3yr open issue) | `revoke()` | First-class `"cancelled"` state + cascade + cleanup hooks |
| Test utilities | None (needs real Redis) | None | In-memory runner + time control |
| OpenTelemetry | Plugin (fragile) | None | Built-in spans + context propagation |
| Realtime UI | None (need Bull Board) | Flower (admin only) | SSE stream + React hooks |
