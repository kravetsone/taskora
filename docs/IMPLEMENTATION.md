# taskora — Implementation Plan

## Tech Stack

- **Runtime**: Node.js 20+ (also targeting Bun/Deno)
- **Language**: TypeScript 5.x (strict mode)
- **Redis client**: ioredis
- **Redis version**: 7.0+ (for LMPOP, advanced Lua, etc.)
- **Test framework**: Vitest
- **Build**: pkgroll (already used in jobify)
- **Lint/Format**: Biome
- **Schema**: `@standard-schema/spec` (peer dep, types only)

## Redis Key Layout

```
taskora:<prefix>:<task>:id              — String: auto-increment job counter
taskora:<prefix>:<task>:meta            — Hash: task metadata (version, options)
taskora:<prefix>:<task>:wait            — List: jobs waiting (FIFO)
taskora:<prefix>:<task>:active          — List: jobs being processed
taskora:<prefix>:<task>:delayed         — Sorted Set: delayed jobs (score = ts * 0x1000 + ord)
taskora:<prefix>:<task>:prioritized     — Sorted Set: priority jobs (score = priority * 2^32 + counter)
taskora:<prefix>:<task>:completed       — Sorted Set: done jobs (score = finishedOn)
taskora:<prefix>:<task>:failed          — Sorted Set: failed jobs (score = finishedOn)
taskora:<prefix>:<task>:stalled         — Set: candidate stalled job IDs
taskora:<prefix>:<task>:stalled-check   — String (PX): stall detection throttle
taskora:<prefix>:<task>:events          — Stream: event log (~10k cap)
taskora:<prefix>:<task>:<jobId>         — Hash: job data, opts, state, result
taskora:<prefix>:<task>:<jobId>:lock    — String (PX): per-job distributed lock
taskora:<prefix>:schedules              — Hash: schedule definitions
taskora:<prefix>:schedules:next         — Sorted Set: next run times
```

## Source Layout

```
src/
├── index.ts                  — public API re-exports
├── app.ts                    — createApp(), App class
├── task.ts                   — Task class, task definition
├── worker.ts                 — Worker loop, job processing
├── context.ts                — TaskContext (ctx in handlers)
├── result.ts                 — ResultHandle (thenable)
├── schema.ts                 — Standard Schema integration + migrations
├── types.ts                  — shared TypeScript types
├── errors.ts                 — error classes
│
├── backend/
│   ├── interface.ts          — Backend abstract interface
│   ├── redis.ts              — Redis backend implementation
│   └── lua/                  — Lua scripts (loaded at startup)
│       ├── enqueue.lua
│       ├── enqueueDelayed.lua
│       ├── dequeue.lua       — promote delayed + RPOPLPUSH + set lock
│       ├── ack.lua           — complete job: verify lock, move to completed, emit event
│       ├── fail.lua          — fail job: verify lock, retry or move to failed
│       ├── extendLock.lua
│       ├── stalledCheck.lua  — two-phase stall detection
│       └── promoteDelayed.lua
│
├── scheduler/
│   ├── scheduler.ts          — schedule runner (intervals + cron)
│   ├── cron.ts               — cron expression parser
│   └── missed.ts             — missed run policy logic
│
├── middleware.ts              — middleware chain (Koa-style compose)
├── events.ts                 — event emitter + Redis Stream bridge
├── inspector.ts              — Inspector API
├── dlq.ts                    — dead letter queue
│
└── workflow/                  — Phase 2
    ├── signature.ts
    ├── chain.ts
    ├── group.ts
    └── chord.ts

tests/
├── helpers/
│   ├── redis.ts              — test Redis connection, cleanup between tests
│   └── wait.ts               — waitFor helpers
├── unit/
│   ├── schema.test.ts        — validation, migration chain, version resolution
│   ├── cron.test.ts          — cron expression parsing
│   ├── retry.test.ts         — backoff calculation, jitter
│   ├── middleware.test.ts    — compose, ordering, error propagation
│   └── result.test.ts       — thenable behavior
└── integration/
    ├── lifecycle.test.ts     — enqueue → process → complete full cycle
    ├── delayed.test.ts       — delayed jobs promote correctly
    ├── retry.test.ts         — retry behavior end-to-end
    ├── stalled.test.ts       — stall detection + recovery
    ├── events.test.ts        — event delivery
    ├── scheduler.test.ts     — cron + interval execution
    ├── inspector.test.ts     — state queries
    ├── migration.test.ts     — versioned jobs processed correctly
    └── concurrency.test.ts   — multiple workers, no double-processing
```

---

## Phases

### Phase 0: Project Skeleton

**Goal**: Buildable, testable, empty project with Redis connectivity.

**Tasks**:
- [ ] Init new package (or reset jobify repo)
- [ ] `package.json` with deps: `ioredis`, dev deps: `vitest`, `typescript`, `pkgroll`, `@biomejs/biome`
- [ ] `tsconfig.json` (strict, ESM, NodeNext)
- [ ] `biome.json`
- [ ] `src/index.ts` — empty export
- [ ] `src/types.ts` — core type definitions (JobState, JobOptions, TaskOptions, BackendInterface)
- [ ] `src/errors.ts` — error classes (TaskoraError, ValidationError, RetryError, StalledError)
- [ ] Test helper: connect to Redis, `flushdb` between tests
- [ ] CI: GitHub Actions running tests against Redis 7

**Testable**: `vitest` runs, connects to Redis, passes a smoke test.

**Ship**: Nothing. Internal only.

---

### Phase 1: Core Engine (MVP)

**Goal**: Define a task, dispatch a job, process it, complete/fail it. The minimum working task queue.

**Tasks**:

1. **Backend interface** (`src/backend/interface.ts`)
   - [ ] Define `Backend` interface with core methods
   - [ ] `enqueue(task, data, options) → jobId`
   - [ ] `dequeue(task) → RawJob | null`
   - [ ] `ack(jobId, result) → void`
   - [ ] `fail(jobId, error) → void`
   - [ ] `connect() / disconnect()`

2. **Lua scripts** (the hard part)
   - [ ] `enqueue.lua` — INCR id + HMSET job hash + LPUSH to wait + XADD event
   - [ ] `dequeue.lua` — RPOPLPUSH wait→active + SET lock with PX + HSET processedOn
   - [ ] `ack.lua` — verify lock token + LREM from active + ZADD to completed + HSET result + XADD event
   - [ ] `fail.lua` — verify lock token + LREM from active + ZADD to failed + HSET error + XADD event

3. **Redis backend** (`src/backend/redis.ts`)
   - [ ] Load Lua scripts on connect (SCRIPT LOAD or inline EVAL)
   - [ ] Connection management (accept string URL, options object, or IORedis instance)
   - [ ] Implement Backend interface using Lua scripts

4. **App** (`src/app.ts`)
   - [ ] `createApp(options)` factory
   - [ ] Task registry (Map of name → TaskDefinition)
   - [ ] `app.task(name, handler)` — minimal form (name + function)
   - [ ] `app.task(name, options)` — options form (with handler in options)
   - [ ] `app.start()` — start workers for all registered tasks
   - [ ] `app.close(options?)` — graceful shutdown

5. **Task** (`src/task.ts`)
   - [ ] `task.dispatch(data, options?)` — enqueue via backend
   - [ ] `task.dispatchMany(jobs)` — bulk enqueue
   - [ ] Store task config (concurrency, timeout)

6. **Worker** (`src/worker.ts`)
   - [ ] Worker loop: poll for jobs (BRPOPLPUSH with timeout for blocking)
   - [ ] Process job: deserialize data → call handler → ack or fail
   - [ ] Concurrency control (process N jobs simultaneously)
   - [ ] Lock extension on interval (prevent stall false-positives)
   - [ ] Graceful shutdown: stop accepting, wait for active to finish

7. **Delayed jobs**
   - [ ] `enqueueDelayed.lua` — HMSET + ZADD to delayed set
   - [ ] `promoteDelayed.lua` — ZRANGEBYSCORE + move to wait
   - [ ] Delayed promotion timer in worker (check every 1s)
   - [ ] `dispatch(data, { delay: 5000 })` support

**Tests**:
- Integration: dispatch → process → complete (happy path)
- Integration: dispatch → process → fail (error in handler)
- Integration: delayed job promotes and processes after delay
- Integration: concurrent workers don't double-process
- Integration: graceful shutdown waits for active jobs
- Unit: connection accepts string, object, IORedis instance

**Testable**: Full job lifecycle works. You can define tasks, dispatch jobs, and they get processed.

**Ship**: Could be an alpha. Functional but no schema, no retries, no events.

---

### Phase 2: Schema Validation + Type Inference

**Goal**: Standard Schema integration. Input validated on dispatch, output validated on complete. Full type inference.

**Tasks**:
- [ ] `src/schema.ts` — validation wrapper around `~standard.validate()`
- [ ] `input` option on task: validate data before enqueue
- [ ] `output` option on task: validate handler return before ack
- [ ] Type inference: `TInput` from schema → `handler(data)` typed → `dispatch(data)` typed
- [ ] Error: `ValidationError` with issues array from Standard Schema
- [ ] `@standard-schema/spec` as optional peer dependency (types only)
- [ ] Fallback: if no schema, use TypeScript generics from handler signature

**Tests**:
- Unit: validate with Zod schema, Valibot schema (both implement Standard Schema)
- Unit: validation failure returns proper error with issues
- Integration: dispatch with invalid data → rejected before enqueue
- Integration: handler returns invalid output → job fails with ValidationError
- Type tests: verify inference works (use `tsd` or `expect-type`)

---

### Phase 3: Result Handle + Job State

**Goal**: `dispatch()` returns a thenable handle for tracking job progress and result.

**Tasks**:
- [ ] `src/result.ts` — `ResultHandle<TOutput>` class
- [ ] Thenable: implements `then()` so `await handle` resolves to result
- [ ] `handle.id` — synchronous, available immediately
- [ ] `handle.getState()` — query Redis for current state
- [ ] `handle.waitFor(timeout)` — poll or subscribe until done
- [ ] `handle.onProgress(callback)` — subscribe to progress events
- [ ] Backend: `getState(jobId)`, `getResult(jobId)`, `subscribe(jobId, event)`
- [ ] Redis: subscribe to Stream events filtered by jobId

**Tests**:
- Integration: `await handle` resolves to handler return value
- Integration: `handle.getState()` returns correct state at each lifecycle point
- Integration: `handle.waitFor()` throws on timeout
- Unit: ResultHandle is a valid thenable (works with Promise.all, etc.)

---

### Phase 4: Retries

**Goal**: Declarative and manual retry support with backoff strategies.

**Tasks**:
- [ ] Retry config: `{ max, backoff, maxDelay, jitter, retryOn, noRetryOn }`
- [ ] Backoff strategies: `"fixed"`, `"exponential"`, `"linear"`, or custom function
- [ ] `fail.lua` update: if retries remaining → re-enqueue to delayed (with backoff delay)
- [ ] Job hash: store `attempt` count, `maxAttempts`
- [ ] `ctx.retry({ delay?, reason? })` — throw `RetryError` for manual retry
- [ ] `retryOn` / `noRetryOn`: match error constructors to decide retry
- [ ] Jitter: randomize delay ±25% to prevent thundering herd
- [ ] Event: `retrying` event with attempt number and next attempt time

**Tests**:
- Unit: backoff calculation (exponential: 1s, 2s, 4s, 8s…)
- Unit: jitter stays within bounds
- Unit: `retryOn` / `noRetryOn` filtering
- Integration: job fails 3 times then succeeds on 4th
- Integration: `ctx.retry()` overrides backoff delay
- Integration: `noRetryOn` error goes straight to failed (no retry)
- Integration: max retries exhausted → job moves to failed permanently

---

### Phase 5: Task Context

**Goal**: Full `ctx` object in handlers with progress, logging, heartbeat, abort signal.

**Tasks**:
- [ ] `src/context.ts` — `TaskContext` class
- [ ] `ctx.id`, `ctx.attempt`, `ctx.timestamp` — from job hash
- [ ] `ctx.signal` — `AbortSignal` from `AbortController`, abort on shutdown
- [ ] `ctx.progress(value)` — HSET progress on job + XADD progress event
- [ ] `ctx.log.info/warn/error(msg, meta?)` — RPUSH to `<jobId>:logs` list
- [ ] `ctx.heartbeat()` — extend lock TTL
- [ ] `ctx.retry(options?)` — throw RetryError
- [ ] Timeout: if task has `timeout`, race handler against AbortSignal timer

**Tests**:
- Integration: progress updates visible via `handle.onProgress()`
- Integration: logs queryable after job completes
- Integration: heartbeat prevents stall detection
- Integration: timeout aborts handler and fails job
- Integration: `ctx.signal` fires on app.close()

---

### Phase 6: Events

**Goal**: Typed event emitter on tasks and app. Redis Streams for delivery.

**Tasks**:
- [ ] `src/events.ts` — typed EventEmitter (task-level + app-level)
- [ ] All Lua scripts already emit to `events` Stream — wire up reader
- [ ] Background Stream reader: XREAD BLOCK, parse events, dispatch to emitter
- [ ] Task events: `completed`, `failed`, `retrying`, `progress`, `active`
- [ ] App events: `task:completed`, `task:failed`, `task:active`, `worker:ready`, `worker:error`, `worker:closing`
- [ ] Typed event payloads (result is `TOutput` on completed, etc.)

**Tests**:
- Integration: `sendEmail.on("completed")` fires with typed result
- Integration: `app.on("task:failed")` fires for any task
- Integration: events survive worker reconnection

---

### Phase 7: Stall Detection

**Goal**: Detect crashed workers and recover their jobs.

**Tasks**:
- [ ] `stalledCheck.lua` — two-phase detection:
  1. Jobs in `stalled` Set + no lock → truly stalled → move to wait (or fail if max stalls)
  2. Copy all `active` List IDs into `stalled` Set for next check
- [ ] Stall check interval in worker (default: 30s, configurable)
- [ ] `maxStalledCount` option (default: 1 — fail after second stall)
- [ ] `stalled` event on app
- [ ] Stalled counter per job (HINCRBY in job hash)

**Tests**:
- Integration: simulate worker crash (kill worker mid-job) → job re-appears in wait
- Integration: max stalled count reached → job moves to failed
- Integration: healthy worker with heartbeat is never marked stalled

---

### Phase 8: Scheduling / Cron

**Goal**: `app.schedule()` with intervals, cron expressions, missed-run policies, runtime management.

**Tasks**:
- [ ] `src/scheduler/cron.ts` — cron expression parser (use `cron-parser` or write own)
- [ ] `src/scheduler/scheduler.ts` — scheduler loop
  - Store schedules in Redis Hash + Sorted Set (next run time as score)
  - Poll for due schedules, dispatch task, compute next run
- [ ] `app.schedule(name, config)` — register schedule
- [ ] Inline schedule: `app.task("x", { schedule: { every: "30s" }, handler })` 
- [ ] Duration parsing: `"30s"`, `"5m"`, `"2h"`, `"1d"`
- [ ] Timezone support (use `Intl.DateTimeFormat` or `luxon`)
- [ ] Missed run policy: `"skip"` (default), `"catch-up"`, `"catch-up-limit:N"`
- [ ] `app.schedules.list/pause/resume/update/remove/trigger`
- [ ] Leader election: only one app instance runs the scheduler (Redis SET NX with TTL)

**Tests**:
- Unit: cron expression parsing
- Unit: duration string parsing
- Unit: next run time calculation with timezone
- Integration: interval schedule fires on time
- Integration: cron schedule fires on time
- Integration: paused schedule doesn't fire
- Integration: missed run catch-up creates N jobs
- Integration: only one scheduler runs across multiple app instances

---

### Phase 9: Schema Versioning & Migrations

**Goal**: `version`, `since`, `migrate` (tuple + record forms), `into()` helper.

**Tasks**:
- [ ] Version stored in job hash (`_v` field)
- [ ] `dispatch()` stamps `_v = task.version` on enqueue
- [ ] Worker: version check before processing (nack future, reject expired)
- [ ] Migration chain: run functions in order, skip gaps in record mode
- [ ] Schema validation AFTER migration (`.default()` values applied)
- [ ] Version resolution: tuple → `since + length`, record → explicit `version`
- [ ] `into()` helper function
- [ ] `app.inspect().migrations(taskName)` — version distribution in queue

**Tests**:
- Unit: version resolution for tuple and record forms
- Unit: migration chain runs in correct order
- Unit: `into()` enforces return type (type-level test)
- Integration: old-version job migrates and processes correctly
- Integration: future-version job is nacked (stays in queue)
- Integration: job below `since` is rejected
- Integration: sparse record migration — gaps handled by schema defaults

---

### Phase 10: Inspector + Dead Letter Queue

**Goal**: Full debugging API. DLQ for permanently failed jobs.

**Tasks**:
- [ ] `src/inspector.ts` — Inspector class
- [ ] `inspector.active/waiting/delayed()` — query Redis lists/sets
- [ ] `inspector.stats()` — LLEN/ZCARD across all structures
- [ ] `inspector.find(jobId)` — full job details including logs and timeline
- [ ] `inspector.find(task, jobId)` — typed variant
- [ ] `src/dlq.ts` — Dead Letter Queue
- [ ] DLQ: separate Sorted Set for permanently failed jobs
- [ ] `app.deadLetters.list/retry/retryAll`
- [ ] Configurable DLQ retention (`maxAge`)

**Tests**:
- Integration: inspector returns correct counts
- Integration: `find()` returns logs and timeline
- Integration: permanently failed job appears in DLQ
- Integration: `deadLetters.retry()` re-enqueues job

---

### Phase 11: Middleware

**Goal**: Koa-style composable middleware on app and task level.

**Tasks**:
- [ ] `src/middleware.ts` — `compose()` function (Koa-compose pattern)
- [ ] `app.use(middleware)` — app-level
- [ ] Task option `middleware: [fn, fn]` — per-task
- [ ] Middleware context: task name, job data, attempt, timing
- [ ] Execution order: app middleware → task middleware → handler

**Tests**:
- Unit: compose executes in correct order (onion model)
- Unit: error in middleware propagates correctly
- Integration: app-level middleware wraps all tasks
- Integration: per-task middleware only wraps that task

---

### Phase 12: Workflows (Canvas) — Phase 2

**Goal**: Signatures, chain, group, chord. Type-safe composition.

> This is a major feature. Design is in API_DESIGN.md, implement after core is battle-tested.

**Tasks**:
- [ ] `src/workflow/signature.ts` — `.s()` method on Task, Signature class
- [ ] `src/workflow/chain.ts` — sequential execution, result flows forward
- [ ] `src/workflow/group.ts` — parallel execution, collect all results
- [ ] `src/workflow/chord.ts` — group + callback
- [ ] `.pipe()` syntax on Signature
- [ ] `.map()` and `.chunk()` on Task
- [ ] Workflow state tracking (store DAG in Redis)
- [ ] Atomic workflow dispatch (all-or-nothing)

---

## Milestones

### Alpha (Phases 0–4)

Core engine + schema + results + retries. Enough to replace BullMQ for simple use cases.

```typescript
const app = createApp({ connection: "redis://localhost:6379" })

const sendEmail = app.task("send-email", {
  input: z.object({ to: z.string(), subject: z.string() }),
  retry: { max: 3, backoff: "exponential" },
  handler: async (data) => {
    await mailer.send(data)
    return { messageId: "abc" }
  },
})

await app.start()
const result = await sendEmail.dispatch({ to: "a@b.com", subject: "Hi" })
// result = { messageId: "abc" }
```

### Beta (Phases 5–9)

Full context, events, scheduling, stall detection, migrations. Production-ready for most workloads.

```typescript
const sendEmail = app.task("send-email", {
  version: 2,
  input: z.object({
    to: z.string(),
    subject: z.string(),
    html: z.boolean().default(false),
  }),
  schedule: { cron: "0 9 * * MON-FRI", timezone: "America/New_York" },
  handler: async (data, ctx) => {
    ctx.progress(50)
    ctx.log.info("Sending email", { to: data.to })
    await mailer.send(data)
    return { sent: true }
  },
})

sendEmail.on("completed", (e) => console.log(`Done in ${e.duration}ms`))
```

### 1.0 (Phases 10–11)

Inspector, DLQ, middleware. Full feature parity with BullMQ + better DX.

### 2.0 (Phase 12)

Workflows. The Celery Canvas killer feature, with TypeScript type safety.

---

## Critical Implementation Notes

### Lua Scripts Are Everything

Every multi-step state transition MUST be a Lua script. No exceptions. If enqueue does `INCR` + `HMSET` + `LPUSH` as separate commands, a crash between them leaves orphan data.

**Required Lua scripts** (minimum for Phase 1):

| Script | Operations | Why atomic |
|--------|-----------|------------|
| `enqueue` | INCR id + HMSET job + LPUSH wait + XADD event | No orphan job data |
| `enqueueDelayed` | INCR id + HMSET job + ZADD delayed + XADD event | No orphan delayed entries |
| `dequeue` | Promote delayed + RPOPLPUSH wait→active + SET lock + HSET processedOn | No double-processing |
| `ack` | Verify lock + LREM active + ZADD completed + HSET result + XADD event | No lost completions |
| `fail` | Verify lock + LREM active + (re-enqueue OR ZADD failed) + XADD event | No lost failures |
| `extendLock` | GET lock (verify token) + SET PX + SREM stalled | Lock stays consistent |

### Delayed Job Promotion

BullMQ's trick: promote delayed jobs INSIDE the dequeue script. When a worker asks for work, the script first checks `ZRANGEBYSCORE delayed 0 now` and moves due jobs to wait. This means no separate timer is strictly needed for correctness, though a background timer improves latency.

### Stall Detection Is Two-Phase

1. End of check: SADD all active job IDs into `stalled` Set
2. Start of NEXT check: jobs still in `stalled` Set AND no lock key → truly stalled

This prevents false positives (a job that was just dequeued but hasn't started processing yet).

### Score Encoding for Delayed Jobs

```
score = timestamp * 0x1000 + ordinal
```

Preserves FIFO ordering among jobs with the same delay timestamp. Up to 4096 jobs per millisecond.

### Leader Election for Scheduler

Only one app instance should run the cron scheduler. Use `SET schedulerLock NX PX 30000` + renewal.
If the lock holder dies, another instance takes over after 30s.
