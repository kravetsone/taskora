# taskora

Task queue library for Node.js. TypeScript-first, Celery-inspired, BullMQ replacement.

## Project overview

- **Package name**: `taskora` (npm available)
- **Repo**: Resetting the `jobify` repo — new library from scratch
- **Design docs**: `docs/API_DESIGN.md` (API surface), `docs/IMPLEMENTATION.md` (phases, Redis layout, Lua scripts)

## Tech stack

- **Language**: TypeScript 5.x (strict mode)
- **Module system**: ESM-first (`"type": "module"`) with CJS build output
- **tsconfig**: `module: "NodeNext"`, `moduleResolution: "NodeNext"` — use `.js` extensions in imports
- **Build**: pkgroll (multi-entrypoint: `.`, `./redis`, future `./postgres`)
- **Lint/format**: Biome — 2 spaces, double quotes, organize imports, `noExplicitAny: off`
- **Test framework**: Vitest (pool: forks, singleFork: true)
- **Test infra**: `@testcontainers/redis` — no docker-compose, no local Redis needed
- **Package manager**: Bun
- **CI**: GitHub Actions — ubuntu-latest, setup-bun + setup-node, Docker (testcontainers auto-pulls redis:7-alpine)
- **Redis client**: ioredis (peer dep of `taskora/redis`)
- **Redis version**: 7.0+
- **Schema validation**: `@standard-schema/spec` (peer dep, types only)

## Package structure

```
taskora              — core engine, types, task API (zero DB deps)
taskora/redis        — Redis adapter (peer dep: ioredis)
taskora/postgres     — future
taskora/test         — in-memory runner (future)
taskora/telemetry    — OpenTelemetry adapter (future)
taskora/react        — React hooks (future)
```

`ioredis` is an optional peer dep — only required when using `taskora/redis`.

## Source layout

```
src/
├── index.ts              — public API: taskora() factory, re-exports
├── app.ts                — App class
├── task.ts               — Task class
├── worker.ts             — Worker loop
├── context.ts            — Taskora.Context (ctx in handlers)
├── result.ts             — ResultHandle (thenable)
├── backoff.ts            — Backoff computation + retry eligibility
├── schema.ts             — Standard Schema integration
├── serializer.ts         — Serializer interface + json() default
├── types.ts              — Taskora namespace (all public types)
├── errors.ts             — Error classes
├── emitter.ts            — Lightweight typed EventEmitter
├── scheduler/
│   ├── index.ts          — re-exports
│   ├── scheduler.ts      — Scheduler class (leader election, poll, dispatch)
│   └── duration.ts       — Duration type + parseDuration()
├── redis/
│   ├── index.ts          — redisAdapter() factory
│   ├── backend.ts        — Adapter implementation
│   ├── event-reader.ts   — XREAD BLOCK stream reader
│   ├── job-waiter.ts     — Push-based ResultHandle (shared XREAD)
│   └── scripts.ts        — Lua scripts (inline, SCRIPT LOAD)
└── ...
```

## Conventions

- All public types live under the `Taskora` namespace — `import type { Taskora } from "taskora"`
- Adapter interface is the abstraction boundary — core never imports ioredis/pg directly
- Every multi-step Redis state transition MUST be a Lua script (atomicity)
- Split storage: job metadata hash (ziplist) + separate `:data` and `:result` string keys
- All keys for one job share a `{hash tag}` for Redis Cluster compatibility

## Commands

```bash
bun install              # install deps
bun run build            # pkgroll build
bun test                 # vitest (needs Docker for integration tests)
bun run lint             # biome check
bun run format           # biome format --write
```

## Implementation phases

Phases 1–8 completed. See `docs/IMPLEMENTATION.md` for full phase breakdown. Next: **Phase 9: Schema Versioning & Migrations**.

Phase 1 delivered:
- Expanded `Taskora.Adapter` interface (8 methods: enqueue, dequeue, ack, fail, nack, extendLock, connect, disconnect)
- 7 atomic Lua scripts with split storage + XADD events (enqueue, enqueueDelayed, dequeue, ack, fail, nack, extendLock)
- Redis backend: SCRIPT LOAD/EVALSHA with NOSCRIPT fallback, lazyConnect, {hash tag} Cluster compat
- `Taskora.Serializer` interface + `json()` default
- `Task<TInput, TOutput>` class with `dispatch()` / `dispatchMany()`
- `Worker`: BZPOPMIN marker-based blocking dequeue, concurrency control, lock extension (30s/10s), graceful shutdown with AbortSignal
- `App`: task registry, `start()` / `close()`, auto-connect on first dispatch
- Property name: `adapter` (not `backend`) — consistent with `Taskora.Adapter` / `redisAdapter()`
- Key prefix optional, omitted by default: `taskora:{task}:key`
- 13 integration tests (lifecycle, delayed, concurrency, shutdown, bulk, connection modes)

Phase 3 delivered:
- `ResultHandle<TOutput>` — thenable class returned synchronously from `dispatch()`
- `dispatch()` is sync: returns handle immediately with UUID v4 id
- `await handle` = ensure enqueued (resolves to id string, backward compatible)
- `handle.result` / `handle.waitFor(ms)` = push-based via shared XREAD connection (JobWaiter)
- `handle.getState()` = query adapter for current `JobState | null`
- Adapter additions: `getState()`, `getResult()`, `getError()` — plain reads, no Lua
- Job IDs: switched from INCR integers to client-side UUID v4 (`crypto.randomUUID()`)
- `JobFailedError`, `TimeoutError` error classes in `errors.ts`
- `enqueue` signature changed: adapter receives `jobId` from client
- 10 new integration tests (36 total)

Phase 4 delivered:
- `Taskora.RetryConfig`: `{ attempts, backoff?, delay?, maxDelay?, jitter?, retryOn?, noRetryOn? }`
- `Taskora.BackoffStrategy`: `"fixed" | "exponential" | "linear" | ((attempt) => number)`
- `retry.attempts` = total attempts (BullMQ model): `attempts: 3` → 3 total, 2 retries
- `src/backoff.ts`: `computeDelay()` (strategies + maxDelay cap + ±25% jitter default on), `shouldRetry()` (noRetryOn/retryOn filtering)
- `fail.lua` rewritten: branches on `retryDelay` — retry path: HINCRBY attempt, state="retrying", ZADD delayed, XADD "retrying" event; else permanent fail
- `enqueue.lua` / `enqueueDelayed.lua`: store `maxAttempts` in job hash (observability)
- `Adapter.fail()` signature: `fail(task, jobId, token, error, retry?: { delay })` — worker decides, Lua executes
- `Adapter.enqueue()` signature: accepts `maxAttempts` option
- Worker retry logic: `RetryError` → always retry (bypass filters), `noRetryOn` → skip, `retryOn` → whitelist, else check attempts
- `ctx.retry({ delay?, reason? })` → returns `RetryError` (user throws); also `throw new RetryError()` works directly
- `RetryError` delay overrides computed backoff
- 15 unit tests (backoff strategies, jitter bounds, retryOn/noRetryOn), 9 integration tests (60 total)

Phase 5 delivered:
- `ctx.progress(value)` — fire-and-forget HSET + XADD progress event; value is number or object
- `ctx.log.info/warn/error(msg, meta?)` — fire-and-forget RPUSH to `{jobId}:logs` as structured `LogEntry`
- `Taskora.LogEntry`: `{ level, message, meta?, timestamp }`
- `Taskora.ContextLog` interface: `info()`, `warn()`, `error()`
- Timeout: worker races handler against `setTimeout` → `TimeoutError` + `controller.abort("timeout")`
- `TimeoutError` not retried by default — user must add to `retryOn` explicitly
- `handle.getProgress()` — returns number, object, or null
- `handle.getLogs()` — returns `LogEntry[]`
- Adapter additions: `setProgress()`, `addLog()`, `getProgress()`, `getLogs()` — plain Redis commands
- 9 new integration tests (69 total)

Phase 6 delivered:
- Typed event emitter: `task.on("completed" | "failed" | "retrying" | "progress" | "active", handler)`
- App events: `app.on("task:completed" | "task:failed" | "task:active" | "worker:ready" | "worker:error" | "worker:closing")`
- `src/emitter.ts`: lightweight `TypedEmitter<TEventMap>` (Map of handlers)
- `src/redis/event-reader.ts`: XREAD BLOCK on duplicate connection, per-event enrichment (HMGET/GET pipeline)
- `Adapter.subscribe(tasks, handler)` — background stream reader, lazy subscriber connection
- `retrying` stream event dispatches both `failed` (willRetry=true) and `retrying` events
- Subscription snapshots stream positions via XREVRANGE before workers start (prevents race)
- Push-based `ResultHandle`: `Adapter.awaitJob()` + `JobWaiter` (shared XREAD connection, periodic state fallback)
- BZPOPMIN marker-based blocking dequeue: marker ZSET (score=0 immediate, score=timestamp delayed), `moveToActive.lua` re-adds marker if more work, all Lua scripts ZADD marker, `ZADD LT` for delayed, dedicated blocking connection per task
- `Adapter.blockingDequeue()` — BZPOPMIN + moveToActive loop, fast-path non-blocking attempt first
- Worker rewritten: no backoff, BZPOPMIN-driven poll loop with 2s block timeout
- 12 new integration tests (81 total)

Phase 7 delivered:
- `stalledCheck.lua` — two-phase detection: resolve stalled candidates (no lock = truly stalled), then SADD all active IDs for next check
- `extendLock.lua` already SREMs healthy jobs from stalled set (Phase 1)
- `Adapter.stalledCheck(task, maxStalledCount)` — returns `{ recovered: string[]; failed: string[] }`
- Worker runs stall check on `setInterval` (default 30s, configurable)
- `Taskora.StallConfig`: `{ interval?: number; maxCount?: number }` — per-task + app defaults
- `maxStalledCount` default 1: re-queue on first stall, fail on second
- `stalledCount` field in job hash (HINCRBY)
- `stalled` event: `{ id, count, action: "recovered" | "failed" }` on task + app (`task:stalled`)
- Failed stalled jobs also emit `failed` stream event
- No throttle key — Lua script is idempotent across concurrent workers
- 7 new integration tests (88 total)

Phase 8 delivered:
- `app.schedule(name, config)` — register named schedules with interval or cron
- Inline schedule: `app.task("x", { schedule: { every: "30s" }, handler })`
- `Duration` template literal type: `number | \`${number}s\` | \`${number}m\` | \`${number}h\` | \`${number}d\``
- `parseDuration()` — converts "30s", "5m", "2h", "1d" to milliseconds
- `cron-parser` (optional peer dep) — dynamic import, only loaded for `cron:` schedules
- `src/scheduler/` directory: `scheduler.ts` (Scheduler class), `duration.ts` (Duration type + parser), `index.ts`
- Redis keys: `taskora:<pfx>:schedules` (Hash), `taskora:<pfx>:schedules:next` (Sorted Set), `taskora:<pfx>:schedules:lock` (String PX)
- `TICK_SCHEDULER` Lua — atomic claim: ZRANGEBYSCORE + ZREM + HGET configs
- `ACQUIRE_SCHEDULER_LOCK` / `RENEW_SCHEDULER_LOCK` Lua — SET NX PX / GET + compare token
- Leader election: SET NX PX 30s, token-based renewal, automatic failover
- Scheduler poll loop: configurable interval (default 1s), non-fatal error handling
- Overlap prevention: `overlap: false` (default) — checks `lastJobId` state before dispatching
- Missed run policy: `"skip"` (default), `"catch-up"`, `"catch-up-limit:N"`
- `app.schedules.list/pause/resume/update/remove/trigger` — runtime schedule management
- `Taskora.ScheduleConfig`, `ScheduleInfo`, `SchedulerConfig`, `MissedPolicy`, `ScheduleRecord` types
- Adapter additions: `addSchedule`, `removeSchedule`, `getSchedule`, `listSchedules`, `tickScheduler`, `updateScheduleNextRun`, `pauseSchedule`, `resumeSchedule`, `acquireSchedulerLock`, `renewSchedulerLock`
- Scheduler starts if `pendingSchedules.length > 0` OR `scheduler` config is provided
- 8 unit tests (parseDuration), 12 integration tests (108 total)
