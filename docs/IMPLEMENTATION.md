# taskora — Implementation Plan

## Tech Stack

- **Runtime**: Node.js 20+ (also targeting Bun/Deno)
- **Language**: TypeScript 5.x (strict mode)
- **Redis client**: ioredis (peer dep of `taskora/redis`)
- **Redis version**: 7.0+ (for LMPOP, advanced Lua, etc.)
- **Test framework**: Vitest
- **Test infra**: `@testcontainers/redis` (Docker-based Redis for e2e)
- **Build**: pkgroll (already used in jobify)
- **Lint/Format**: Biome
- **Schema**: `@standard-schema/spec` (peer dep, types only)

## Redis Key Layout

All keys for one job share a `{hash tag}` so they land in the same Redis Cluster slot.

```
Queue-level keys:
  taskora:<pfx>:<task>:id               — String: auto-increment job counter
  taskora:<pfx>:<task>:meta             — Hash: task metadata (version, options)
  taskora:<pfx>:<task>:wait             — List: jobs waiting (FIFO)
  taskora:<pfx>:<task>:active           — List: jobs being processed
  taskora:<pfx>:<task>:delayed          — Sorted Set: delayed jobs (score = ts * 0x1000 + ord)
  taskora:<pfx>:<task>:prioritized      — Sorted Set: priority jobs (score = priority * 2^32 + ctr)
  taskora:<pfx>:<task>:completed        — Sorted Set: done jobs (score = finishedOn)
  taskora:<pfx>:<task>:failed           — Sorted Set: failed jobs (score = finishedOn)
  taskora:<pfx>:<task>:stalled          — Set: candidate stalled job IDs
  taskora:<pfx>:<task>:stalled-check    — String (PX): stall detection throttle
  taskora:<pfx>:<task>:events           — Stream: event log (~10k cap)

Per-job keys (split storage for ziplist optimization):
  {taskora:<pfx>:<task>:<jobId>}        — Hash (ziplist): metadata only
                                            ts, delay, priority, attempt, _v, state
                                            all values < 64 bytes → ziplist encoding
  {taskora:<pfx>:<task>:<jobId>}:data   — String: serialized input (via Taskora.Serializer)
  {taskora:<pfx>:<task>:<jobId>}:result — String: serialized output (after complete)
  {taskora:<pfx>:<task>:<jobId>}:lock   — String (PX): per-job distributed lock
  {taskora:<pfx>:<task>:<jobId>}:logs   — List: structured log entries from ctx.log

Schedule keys:
  taskora:<pfx>:schedules               — Hash: schedule definitions
  taskora:<pfx>:schedules:next          — Sorted Set: next run times
  taskora:<pfx>:schedules:lock          — String (PX): leader election lock
```

**Why split storage:** Keeping serialized `data` and `result` out of the metadata hash ensures all hash values stay under 64 bytes. Redis uses ziplist encoding for such hashes — **3-4x less memory overhead** than hashtable encoding. In Lua scripts, accessing 3 keys costs the same as 1 (server-side, zero RTT).

## Source Layout

```
src/
├── index.ts                  — public API: taskora(), Task, types (zero DB deps)
├── app.ts                    — taskora() factory, App class
├── task.ts                   — Task class, task definition
├── worker.ts                 — Worker loop, job processing
├── context.ts                — Taskora.Context (ctx in handlers)
├── result.ts                 — ResultHandle (thenable)
├── schema.ts                 — Standard Schema integration + migrations
├── serializer.ts             — Taskora.Serializer interface + json() default
├── types.ts                  — Taskora namespace (Adapter, JobState, JobOptions, ...)
├── errors.ts                 — error classes
│
├── serializers/              — optional serializer entrypoints
│   ├── msgpack.ts            — "taskora/serializers/msgpack" (peer dep: @msgpack/msgpack)
│   └── cbor.ts               — "taskora/serializers/cbor" (peer dep: cbor-x)
│
├── redis/                    — "taskora/redis" entrypoint
│   ├── index.ts              — redis() adapter factory
│   ├── backend.ts            — Taskora.Adapter implementation using ioredis
│   └── lua/                  — Lua scripts (loaded at connect)
│       ├── enqueue.lua
│       ├── enqueueDelayed.lua
│       ├── dequeue.lua       — promote delayed + RPOPLPUSH + set lock
│       ├── ack.lua           — verify lock, move to completed, emit event
│       ├── fail.lua          — verify lock, retry or move to failed
│       ├── nack.lua          — return job to wait queue (future version)
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
├── setup.ts                  — global: start RedisContainer, export connection
├── helpers/
│   ├── containers.ts         — testcontainers setup/teardown
│   └── wait.ts               — waitFor / waitUntil helpers
├── unit/
│   ├── schema.test.ts        — validation, migration chain, version resolution
│   ├── cron.test.ts          — cron expression parsing
│   ├── retry.test.ts         — backoff calculation, jitter
│   ├── middleware.test.ts    — compose, ordering, error propagation
│   └── result.test.ts        — thenable behavior
└── integration/
    ├── lifecycle.test.ts      — enqueue → process → complete full cycle
    ├── delayed.test.ts        — delayed jobs promote correctly
    ├── retry.test.ts          — retry behavior end-to-end
    ├── stalled.test.ts        — stall detection + recovery
    ├── events.test.ts         — event delivery
    ├── scheduler.test.ts      — cron + interval execution
    ├── inspector.test.ts      — state queries
    ├── migration.test.ts      — versioned jobs processed correctly
    └── concurrency.test.ts    — multiple workers, no double-processing
```

---

## Phases

### Phase 0: Project Skeleton

**Goal**: Buildable, testable, empty project with Redis in Docker.

**Tasks**:
- [ ] Init new package (or reset jobify repo)
- [ ] `package.json`:
  - deps: (none — core has zero deps)
  - peer deps: `ioredis` (for `taskora/redis`)
  - dev deps: `vitest`, `typescript`, `pkgroll`, `@biomejs/biome`, `@testcontainers/redis`, `ioredis`
- [ ] `tsconfig.json` (strict, ESM, NodeNext)
- [ ] `biome.json`
- [ ] Multi-entrypoint build setup (see below)
- [ ] `src/index.ts` — `taskora()` factory export, types
- [ ] `src/redis/index.ts` — `redisAdapter()` export
- [ ] `src/types.ts` — `Taskora` namespace (Adapter, JobState, JobOptions, Context, ...)
- [ ] `src/errors.ts` — error classes (TaskoraError, ValidationError, RetryError, StalledError)
- [ ] Test infra: testcontainers setup (see Testing section)
- [ ] CI: GitHub Actions with Docker (testcontainers handles Redis)

**Testable**: `vitest` runs, spins up Redis in Docker, passes a smoke test.

**Ship**: Nothing. Internal only.

#### Multi-entrypoint package.json

```jsonc
{
  "name": "taskora",
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    },
    "./redis": {
      "import": "./dist/redis/index.mjs",
      "require": "./dist/redis/index.cjs",
      "types": "./dist/redis/index.d.ts"
    }
  },
  "peerDependencies": {
    "ioredis": ">=5"
  },
  "peerDependenciesMeta": {
    "ioredis": { "optional": true }
  }
}
```

`ioredis` is optional at the package level — only required if you use `taskora/redis`. TypeScript will error at import time if missing.

---

### Phase 1: Core Engine (MVP)

**Goal**: Define a task, dispatch a job, process it, complete/fail it. The minimum working task queue.

**Tasks**:

1. **Adapter interface** (`src/types.ts`)
   - [ ] Define `Taskora.Adapter` interface with core methods
   - [ ] `enqueue(task, data, options) → jobId`
   - [ ] `dequeue(task) → RawJob | null`
   - [ ] `ack(jobId, result) → void`
   - [ ] `fail(jobId, error) → void`
   - [ ] `nack(jobId) → void` (return to queue — future version jobs)
   - [ ] `reject(jobId, reason) → void` (expired migration)
   - [ ] `connect() / disconnect()`

2. **Lua scripts** (the hard part — all use split storage)
   - [ ] `enqueue.lua` — INCR id + HMSET meta hash + SET :data key + LPUSH to wait + XADD event
   - [ ] `dequeue.lua` — RPOPLPUSH wait→active + SET lock with PX + HSET processedOn + GET :data
   - [ ] `ack.lua` — verify lock + LREM active + SET :result + ZADD completed + XADD event
   - [ ] `fail.lua` — verify lock + LREM active + ZADD failed + HSET error + XADD event
   - [ ] `nack.lua` — verify lock + LREM active + RPUSH back to wait

3. **Redis adapter** (`src/redis/`)
   - [ ] `index.ts` — `redisAdapter()` factory
   - [ ] `backend.ts` — `Taskora.Adapter` implementation
   - [ ] Load Lua scripts on connect (SCRIPT LOAD or inline EVAL)
   - [ ] Connection: accept string URL, options object, or IORedis instance

4. **App** (`src/app.ts`)
   - [ ] `taskora(options)` factory
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
- [ ] Adapter: `getState(jobId)`, `getResult(jobId)`, `subscribe(jobId, event)`
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
- [ ] `src/context.ts` — `Taskora.Context` class
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
- [x] `src/inspector.ts` — Expanded Inspector class (active/waiting/delayed/failed/completed queries)
- [x] `inspector.stats()` — LLEN/ZCARD pipeline across all structures
- [x] `inspector.find(jobId)` — full job details including logs and timeline
- [x] `inspector.find(task, jobId)` — typed variant
- [x] `src/dlq.ts` — DeadLetterManager (view over `:failed` sorted set — no separate `:dead` key)
- [x] `app.deadLetters.list/retry/retryAll`
- [x] Configurable retention (`retention: { completed, failed }`) — `maxAge` + `maxItems`, trim piggybacks on stall check interval
- [x] 3 new Lua scripts: `retryDLQ`, `retryAllDLQ`, `trimDLQ`
- [x] Adapter additions: `listJobs`, `getJobDetails`, `getQueueStats`, `retryFromDLQ`, `retryAllFromDLQ`, `trimDLQ`
- [x] Timeline reconstructed from `ts` → `processedOn` → `finishedOn` (no new hash field needed)

**Tests**:
- [x] Integration: inspector returns correct counts (stats per-task and cross-task)
- [x] Integration: list queries (waiting, completed, failed, delayed, pagination)
- [x] Integration: `find()` returns logs and timeline
- [x] Integration: `find(task, jobId)` typed variant
- [x] Integration: permanently failed job appears in DLQ
- [x] Integration: `deadLetters.retry()` re-enqueues job (with and without task name)
- [x] Integration: `deadLetters.retryAll()` bulk re-enqueue
- [x] Integration: `trimDLQ` removes old jobs and cleans up keys

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

### Phase 12a: Flow Control — Debounce, Throttle, Deduplication

**Goal**: Dispatch-time flow control primitives — all implemented as atomic Lua scripts.

**Tasks**:

1. **Debounce** (Lua: replace existing delayed job with same key)
   - [ ] `debounce.lua` — HGET debounce key → if exists: DEL old job, create new delayed job
   - [ ] Dispatch option: `debounce: { key, delay }`
   - [ ] Redis key: `taskora:<pfx>:<task>:debounce:<key>` → jobId mapping

2. **Throttle** (Lua: check counter, drop if over limit)
   - [ ] `throttle.lua` — INCR counter with PX window, reject if > max
   - [ ] Dispatch option: `throttle: { key, max, window }`
   - [ ] Redis key: `taskora:<pfx>:<task>:throttle:<key>` → counter with PX
   - [ ] Return `null` handle when dropped

3. **Deduplication** (Lua: check existence before enqueue)
   - [ ] Extend `enqueue.lua` — check dedup key, skip if exists
   - [ ] Dispatch option: `deduplicate: { key, while? }`
   - [ ] Redis key: `taskora:<pfx>:<task>:dedup:<key>` → jobId
   - [ ] Clean dedup key on job completion/failure

**Tests**:
- Integration: debounce — 5 dispatches, only last runs
- Integration: throttle — exceeding limit drops jobs
- Integration: deduplication — second dispatch returns existing handle

---

### Phase 12b: Flow Control — TTL, Singleton, Concurrency per Key

**Goal**: Worker-time flow control — TTL expiration, singleton tasks, per-key concurrency limits.

**Tasks**:

1. **TTL / Expiration**
   - [ ] Store `expireAt` in job hash
   - [ ] Worker: check TTL before processing, skip expired
   - [ ] `promoteDelayed.lua`: skip expired delayed jobs
   - [ ] Task option + dispatch option: `ttl`
   - [ ] `onExpire: "fail" | "discard"` behavior

2. **Singleton**
   - [ ] Task option: `singleton: true`
   - [ ] `dequeue.lua`: check active count for task before claiming
   - [ ] Global lock across workers (not per-worker concurrency)

3. **Concurrency per key**
   - [ ] Dispatch option: `concurrencyKey` + `concurrencyLimit`
   - [ ] Redis key: `taskora:<pfx>:<task>:conc:<key>` → active count
   - [ ] `dequeue.lua`: check per-key count before claiming
   - [ ] Decrement on ack/fail

4. **Cron overlap prevention**
   - [ ] Schedule option: `overlap: false`
   - [ ] Scheduler: check if previous run is still active before dispatching
   - [ ] Redis key: `taskora:<pfx>:schedules:<name>:active` → jobId

**Tests**:
- Integration: TTL — expired job not processed
- Integration: singleton — second job waits for first to complete
- Integration: concurrency per key — respects per-key limit
- Integration: cron overlap — skips when previous still active

---

### Phase 12c: Flow Control — Collect (Batch Accumulator)

**Goal**: Debounce + accumulator pattern — collect multiple dispatches into a single batched job.

**Tasks**:

1. **Collect** (debounce + accumulator)
   - [x] `COLLECT_PUSH` Lua — RPUSH item, HINCRBY count, manage flush sentinel, maxSize inline flush
   - [x] Flush via `moveToActive.lua` — drain buffer into `:data` at claim time (no separate flush script)
   - [x] Dispatch: serialize item → `collectPush` adapter method → check flush triggers
   - [x] Flush triggers: delay (debounce), maxSize, maxWait — any first
   - [x] On flush: items become a regular job's `:data` (array) → normal worker picks it up
   - [x] Task typing: `CollectTaskOptions<I, O>` overload, handler receives `TInput[]`
   - [x] HDEL collectKey after drain prevents retry double-drain
   - [x] Redis keys per accumulator:
     ```
     {taskora:<pfx>:<task>:collect:<key>}:items   — List: accumulated items
     {taskora:<pfx>:<task>:collect:<key>}:meta    — Hash: firstAt, lastAt, count
     {taskora:<pfx>:<task>:collect:<key>}:job     — String: flush sentinel job ID
     ```

**Tests** (5 integration, 197 total):
- [x] Integration: collect — 5 dispatches within delay → handler receives array of 5
- [x] Integration: collect dynamic key — groups items by key separately
- [x] Integration: collect maxSize — flush triggers at maxSize even if delay hasn't passed
- [x] Integration: collect maxWait — flush triggers at maxWait even if dispatches keep coming
- [x] Integration: collect failure — batch retries as one job, no data loss

---

### Phase 13: Graceful Cancellation

**Goal**: First-class job cancellation with distinct state, cleanup hooks, and cascade.

BullMQ issue #632 — requested for 3+ years. No clean solution exists.

**Tasks**:
- [x] New `JobState`: `"cancelled"` — distinct from `"failed"`
- [x] `handle.cancel({ reason? })` — cancel a dispatched job
- [x] `cancel.lua` — if waiting/delayed: move to cancelled set. If active: set abort flag
- [x] Worker: check abort flag → fire `AbortSignal` on `ctx.signal`
- [x] `onCancel` hook on task definition — cleanup logic
- [ ] Cascade: cancelling a workflow/chain cancels all pending child jobs (deferred to Phase 17)
- [x] `cancelled` event on task and app
- [x] Inspector: `inspector.cancelled()` query

**Tests**:
- [x] Integration: cancel waiting job → state is "cancelled" not "failed"
- [x] Integration: cancel active job → ctx.signal fires, onCancel runs
- [ ] Integration: cancel chain → all pending steps cancelled (deferred to Phase 17)
- [x] Cancel delayed, retrying, completed (no-op), events, inspector, CancelledError, reason preserved

---

### Phase 14: Test Utilities

**Goal**: `taskora/test` — in-memory runner, time manipulation, zero Redis dependency for unit tests.

**Tasks**:
- [ ] `src/test/index.ts` — `"taskora/test"` entrypoint
- [ ] `createTestRunner()` — in-memory adapter implementing `Taskora.Adapter`
- [ ] In-memory: Lists, Sorted Sets, Hashes in plain JS Maps (minimal Redis emulation)
- [ ] `runner.run(task, data)` — execute handler synchronously, return result
- [ ] `runner.dispatch(task, data, opts?)` — enqueue in memory
- [ ] `runner.advanceTime(duration)` — fast-forward delayed jobs and schedules
- [ ] `runner.flush(task, key?)` — trigger collect flush manually
- [ ] `runner.steps` — inspect completed steps for durable step workflows
- [ ] `runner.jobs` — list all jobs with states
- [ ] `runner.clear()` — reset state between tests

**Tests**:
- Unit: runner processes jobs without Redis
- Unit: advanceTime promotes delayed jobs
- Unit: collect accumulator flushes on advanceTime
- Unit: runner.run returns typed result

---

### Phase 15: OpenTelemetry

**Goal**: Built-in tracing — automatic spans for every job, context propagation from producer to consumer.

**Tasks**:
- [ ] `src/telemetry.ts` — telemetry interface + noop default
- [ ] `taskora/telemetry` entrypoint — `otel()` adapter using `@opentelemetry/api`
- [ ] Dispatch: create span `taskora.dispatch(<task>)`, inject trace context into job hash
- [ ] Worker: extract trace context from job hash, create span `taskora.process(<task>)`
- [ ] Steps: child span per `ctx.step()` call
- [ ] Attributes: `taskora.task`, `taskora.job_id`, `taskora.attempt`, `taskora.version`
- [ ] Error: record exception on span when job fails
- [ ] `@opentelemetry/api` as optional peer dep
- [ ] App option: `telemetry: true` (auto-detect) or `telemetry: otel({ serviceName })` (explicit)

**Produces traces like:**
```
trace: HTTP POST /api/orders
  └─ span: taskora.dispatch(process-order)
      └─ span: taskora.process(process-order)
          ├─ span: step(charge-card)         [200ms]
          ├─ span: step(reserve-shipping)    [350ms]
          └─ span: step(send-confirmation)   [120ms]
```

**Tests**:
- Unit: noop telemetry has zero overhead
- Integration: spans created with correct parent-child relationships
- Integration: trace context propagates from dispatch to worker

---

### Phase 16: Realtime Frontend Hooks

**Goal**: Stream job progress to frontend via SSE. React hooks for subscribing.

**Tasks**:
- [ ] `src/stream.ts` — `createJobStream(app, jobId)` → ReadableStream / SSE
- [ ] SSE events: state changes, progress updates, step completions, result
- [ ] Backed by Redis Stream subscription (events stream, filtered by jobId)
- [ ] `taskora/react` entrypoint — `useJobStatus(jobId, options)` hook
- [ ] Hook returns: `{ state, progress, steps, result, error }`
- [ ] Auto-reconnect on connection drop
- [ ] Framework-agnostic: `createJobStream` works with any HTTP framework
- [ ] React as optional peer dep

**Tests**:
- Integration: SSE stream delivers state changes in order
- Integration: stream closes when job completes
- Unit: React hook updates on incoming events

---

### Phase 17a: Workflows (Canvas) — Core Primitives

**Goal**: Signature, chain, group, chord. Type-safe composition with DAG-based execution. Cascade cancellation. Optional workflow TTL.

**Tasks**:
- [ ] `src/workflow/signature.ts` — Signature class, `.s()` method on Task
- [ ] `src/workflow/chain.ts` — `chain()` with type overloads (up to 10 steps)
- [ ] `src/workflow/group.ts` — `group()` with tuple output inference
- [ ] `src/workflow/chord.ts` — `chord()` group + callback
- [ ] `src/workflow/graph.ts` — `flattenToDAG()`: composition tree → flat `WorkflowGraph`
- [ ] `src/workflow/handle.ts` — `WorkflowHandle` (result waiting, cancel, state)
- [ ] `src/workflow/index.ts` — re-exports
- [ ] `.pipe()` on Signature — unlimited type-safe chaining
- [ ] `.map()` and `.chunk()` on Task — batch sugar
- [ ] Composability — groups/chords valid as chain steps, nested compositions
- [ ] Workflow state tracking — DAG stored as Redis hash
- [ ] Worker integration — advance/fail workflow after job ack/fail
- [ ] Cascade cancellation — cancel workflow cancels all pending/active steps
- [ ] Workflow TTL — optional timeout, implemented as delayed cancel
- [ ] Adapter additions — 6 new methods (createWorkflow, advanceWorkflow, failWorkflow, getWorkflowState, cancelWorkflow, getWorkflowMeta)
- [ ] Lua scripts — 4 new (createWorkflow, advanceWorkflow, failWorkflow, cancelWorkflow)
- [ ] Enqueue extension — `_wf`/`_wfNode` optional fields in job hash
- [ ] MemoryBackend — workflow methods implementation
- [ ] TestRunner — `runner.steps` tracks workflow step history, processOne advances workflows
- [ ] Unit tests (signature, chain types, graph flattening, DAG builder)
- [ ] Integration tests (chain execution, group parallel, chord fan-in, nested, cancel cascade, TTL)

#### Design Decisions

**DAG model** — All compositions (chain, group, chord, nested) flatten to a DAG of task nodes. No virtual join nodes. Each node is a real task invocation with dependency edges:

```
chain(a, b, c)                    → [a, b, c], edges: a→b, b→c
group(a, b, c)                    → [a, b, c], all terminal, no edges
chord([a, b], c)                  → [a, b, c], edges: a→c, b→c
chord([chain(a,b), chain(c,d)], e) → [a,b,c,d,e], edges: a→b, c→d, b→e, d→e
chain(a, group(b, c), d)          → [a,b,c,d], edges: a→b, a→c, b→d, c→d
```

Input resolution: 1 dep → receives that dep's result directly. N deps → receives array of results in dep order. Bound data overrides pipeline input.

**Bound data (full bind vs partial application)** — Chose **full-bind-or-pipe** model over Celery-style partial application.

- `task.s(data)` — data is fixed, pipeline input ignored
- `task.s()` — no data, receives entire previous output as input

*Tradeoff*: Celery's partial application (`add.s(10)` binds one arg, pipeline fills the other) enables more flexible composition but is fundamentally incompatible with TypeScript's type system. Object inputs lack positional semantics, `Omit<T, keyof Partial>` can't distinguish "provided at runtime" from "optional in type", and merge precedence between pipeline and bound data is ambiguous. The full-bind model gives clean single-constraint type checking (`PrevOutput extends NextInput`) with zero type gymnastics. If shape transformation is needed between steps, a lightweight mapping task is more explicit and testable than magic partial merging.

**Worker-side dispatch (not all-in-Lua)** — `advanceWorkflow` Lua does bookkeeping on the workflow hash (single key, Cluster-safe), returns list of ready nodes. Worker dispatches via standard `adapter.enqueue()`. Reason: workflow nodes target different tasks → different Redis key prefixes → can't cross hash slots in Lua. Crash window between advance and enqueue is ~microseconds; recoverable from graph state if needed later.

**Part of core (not separate entrypoint)** — `.s()` lives on Task, workflow hooks in Worker, types in Taskora namespace. Exported from `taskora` directly, source in `src/workflow/`.

**Groups are composable chain steps** — `chain(a, group(b, c), d)` is valid. Group receives a's output, fans out to all members. d receives `[b.result, c.result]`. Falls naturally from the DAG model.

**Workflow TTL** — Optional. Individual jobs use their task-level TTL as before. Additionally, `dispatch({ ttl })` on a workflow sets a global timeout implemented as a delayed cancel.

#### Redis Layout

Single hash per workflow — all state transitions atomic in one Lua call:

```
Key: taskora:wf:{workflowId}

Fields:
  graph       → JSON WorkflowGraph (nodes, terminal indices)
  state       → "running" | "completed" | "failed" | "cancelled"
  createdAt   → timestamp
  result      → serialized final result
  error       → error message
  n:0:state   → "pending" | "active" | "completed" | "failed"
  n:0:result  → serialized result
  n:1:state   → ...
```

Job hash extension: `_wf` (workflow ID) + `_wfNode` (node index) stored alongside existing fields.

#### WorkflowGraph Schema

```typescript
interface WorkflowGraph {
  nodes: WorkflowNode[];
  terminal: number[];   // node indices with no successors — define final result
}
interface WorkflowNode {
  taskName: string;
  data?: string;        // serialized bound data, absent = pipe from predecessor
  deps: number[];       // predecessor node indices
  jobId: string;        // pre-generated UUID at dispatch time
  _v: number;           // task version captured at signature creation
}
```

#### Adapter Additions

```typescript
createWorkflow(workflowId: string, graph: string): Promise<void>;
advanceWorkflow(workflowId: string, nodeIndex: number, result: string): Promise<WorkflowAdvanceResult>;
failWorkflow(workflowId: string, nodeIndex: number, error: string): Promise<WorkflowFailResult>;
getWorkflowState(workflowId: string): Promise<string | null>;
cancelWorkflow(workflowId: string, reason?: string): Promise<WorkflowCancelResult>;
getWorkflowMeta(task: string, jobId: string): Promise<{ workflowId: string; nodeIndex: number } | null>;
```

#### Lua Scripts

| Script | Operates on | Purpose |
|--------|-------------|---------|
| `createWorkflow.lua` | `wf:{id}` hash | HMSET graph + per-node initial states |
| `advanceWorkflow.lua` | `wf:{id}` hash | Mark node done, find ready deps, compute input, return dispatch list |
| `failWorkflow.lua` | `wf:{id}` hash | Mark node + workflow failed, collect active job IDs for cascade cancel |
| `cancelWorkflow.lua` | `wf:{id}` hash | Mark pending/active nodes cancelled, return active job IDs |

#### Type System

Chain overloads (up to 10):
```typescript
function chain<A, B>(s1: Signature<A, B>): ChainSignature<A, B>;
function chain<A, B, C>(s1: Signature<A, B>, s2: Signature<B, C>): ChainSignature<A, C>;
// ...up to 10
```

Group output as mapped tuple:
```typescript
type OutputTuple<T extends Signature<any, any>[]> = {
  [K in keyof T]: T[K] extends Signature<any, infer O> ? O : never;
};
```

Chord connects group tuple to callback:
```typescript
function chord<T extends Signature<any, any>[], CO>(
  header: [...T],
  callback: Signature<OutputTuple<T>, CO>,
): ChordSignature<void, CO>;
```

`.pipe()` — each call is individually type-checked, unlimited depth:
```typescript
class Signature<TInput, TOutput> {
  pipe<TNext>(next: Signature<TOutput, TNext>): ChainSignature<TInput, TNext>;
}
```

#### Worker Integration

After ack — check for workflow fields, advance:
```
ack(job) → HMGET _wf _wfNode → if present: advanceWorkflow(wfId, node, result)
  → for each ready node: adapter.enqueue(taskName, jobId, data, { _wf, _wfNode })
```

After permanent fail — fail workflow, cascade cancel:
```
fail(job, no retry) → HMGET _wf _wfNode → if present: failWorkflow(wfId, node, error)
  → for each active job: adapter.cancel(task, jobId, "workflow failed")
```

#### WorkflowHandle

Pre-generated job IDs for all nodes → terminal IDs known at dispatch time:

```typescript
class WorkflowHandle<TOutput> {
  readonly workflowId: string;
  get result(): Promise<TOutput>;   // awaitJob on terminal node(s)
  cancel(opts?: { reason?: string }): Promise<void>;
  getState(): Promise<WorkflowState>;
}
```

Chain/chord: awaits single terminal job. Group: `Promise.all()` over terminal jobs. Piggybacks on existing push-based `awaitJob()`.

### Phase 17b: Workflows — Advanced Primitives (deferred)

**Goal**: Durable steps, wait-for-event, dynamic fan-out/fan-in as graph node types.

- [ ] Durable steps — memoized step results within workflow graph
- [ ] Wait-for-event — pause node until external signal (new node type in DAG)
- [ ] Fan-out / fan-in — dynamic parallelism (node spawns N children at runtime)
- [ ] Workflow inspector — visualize DAG state, step history

---

## Testing Infrastructure

### Approach: `@testcontainers/redis`

No local Redis install required. Docker spins up a fresh Redis for each test run, tears it down after. Works identically on dev machines and CI.

```bash
# dev deps
npm install -D @testcontainers/redis vitest
```

### Global setup (`tests/setup.ts`)

Start one Redis container for the entire test suite. Vitest `globalSetup` hook — container starts before any test file, stops after all tests.

```typescript
// tests/setup.ts
import { RedisContainer } from "@testcontainers/redis"

let container: Awaited<ReturnType<RedisContainer["start"]>>

export async function setup() {
  container = await new RedisContainer("redis:7-alpine").start()
  // Expose connection URL to all test files via env var
  process.env.REDIS_URL = container.getConnectionUrl()
}

export async function teardown() {
  await container.stop()
}
```

### Per-test isolation (`tests/helpers/containers.ts`)

Each test file gets a clean DB via `SELECT` + `FLUSHDB`. No cross-test pollution.

```typescript
// tests/helpers/containers.ts
import { redisAdapter } from "../../src/redis"
import type { Taskora } from "../../src/types"

export async function createTestAdapter(): Promise<Taskora.Adapter> {
  const adapter = redisAdapter(process.env.REDIS_URL!)
  await adapter.connect()
  return adapter
}

export async function cleanRedis(adapter: Taskora.Adapter) {
  // FLUSHDB between tests — testcontainers Redis is ephemeral anyway
  await adapter._raw().flushdb() // _raw() exposes ioredis for testing
}
```

### Vitest config

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globalSetup: ["tests/setup.ts"],
    testTimeout: 30_000,   // integration tests need time
    hookTimeout: 60_000,   // container startup can be slow first time
    pool: "forks",         // separate processes for isolation
    poolOptions: {
      forks: { singleFork: true }, // share container across test files
    },
  },
})
```

### CI: GitHub Actions

Testcontainers needs Docker. GitHub Actions has it out of the box.

```yaml
# .github/workflows/test.yml
name: Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2  # or setup-node
      - run: bun install
      - run: bun test
      # Docker is pre-installed on ubuntu-latest
      # testcontainers pulls redis:7-alpine automatically
```

No `services:` block needed. No manual Redis setup. Testcontainers handles everything.

### Test categories

| Category | Runs against | Speed | Example |
|---|---|---|---|
| **Unit** | No Redis | <1s per file | Backoff math, cron parsing, middleware compose |
| **Integration** | Testcontainers Redis | 1-5s per file | Full job lifecycle, retries, events |
| **Type** | TypeScript compiler | <5s total | `expect-type` checks for inference |

```bash
bun test              # all tests
bun test unit         # fast, no Docker needed
bun test integration  # needs Docker
```

---

## Milestones

### Alpha (Phases 0–4)

Core engine + schema + results + retries. Enough to replace BullMQ for simple use cases.

```typescript
import { taskora } from "taskora"
import { redisAdapter } from "taskora/redis"

const app = taskora({
  backend: redisAdapter("redis://localhost:6379"),
})

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

### 1.0 (Phases 10–14)

Inspector, DLQ, middleware, flow control, cancellation, test utilities. Full BullMQ replacement + better DX.

### 1.x (Phases 15–16)

OpenTelemetry, realtime frontend hooks. Production observability.

### 2.0 (Phase 17)

Workflows (Canvas) with durable steps, wait-for-event, fan-out/fan-in as graph primitives. The feature that makes taskora a workflow engine, not just a job queue.

---

## Critical Implementation Notes

### Lua Scripts Are Everything

Every multi-step state transition MUST be a Lua script. No exceptions. If enqueue does `INCR` + `HMSET` + `LPUSH` as separate commands, a crash between them leaves orphan data.

**Required Lua scripts** (minimum for Phase 1, all use split storage):

| Script | Keys touched | Operations | Why atomic |
|--------|-------------|-----------|------------|
| `enqueue` | meta hash, :data, wait list, events stream | INCR id + HMSET meta + SET :data + LPUSH wait + XADD | No orphan data |
| `enqueueDelayed` | meta hash, :data, delayed zset, events stream | INCR id + HMSET meta + SET :data + ZADD delayed + XADD | No orphan delayed |
| `dequeue` | wait list, active list, meta hash, :data, :lock | Promote delayed + RPOPLPUSH wait→active + SET lock PX + GET :data | No double-processing |
| `ack` | :lock, active list, :result, completed zset, meta hash, events | Verify lock + LREM active + SET :result + ZADD completed + XADD | No lost completions |
| `fail` | :lock, active list, failed zset, meta hash, events | Verify lock + LREM active + (re-enqueue OR ZADD failed) + XADD | No lost failures |
| `nack` | :lock, active list, wait list | Verify lock + LREM active + RPUSH wait | Future jobs back to queue |
| `extendLock` | :lock, stalled set | GET lock (verify token) + SET PX + SREM stalled | Lock stays consistent |

All keys for one job share a `{hash tag}` — safe in Redis Cluster. Accessing multiple keys in one Lua script = zero extra RTT (server-side, in-memory).

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
