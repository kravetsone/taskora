---
description: How Taskora compares to BullMQ, Agenda, and pg-boss — feature-by-feature breakdown for Node.js task queues.
---

# Comparison

Choosing a task queue for Node.js? Here's an honest feature comparison.

## Feature Matrix

| Feature | Taskora | BullMQ | Agenda | pg-boss |
|---|:---:|:---:|:---:|:---:|
| **TypeScript-native** | Full | Full | Full (v6+) | Full |
| **Schema validation** | Standard Schema | - | - | - |
| **Middleware** | Koa-style onion model | Event hooks | - | - |
| **Job versioning & migrations** | Full migration chains | Version field only | - | - |
| **In-memory test adapter** | Built-in | - | - | - |
| **Virtual time testing** | Built-in | - | - | - |
| **Debounce** | Built-in | Built-in | - | - |
| **Throttle** | Built-in | Pattern-based | - | Singleton slots |
| **Deduplication** | Built-in | Built-in | - | Singleton keys |
| **Batch collect** | Built-in | Pro (paid) | - | - |
| **Cancellation** | Instant (pub/sub) | Supported (Pro enhanced) | - | - |
| **Cron / scheduling** | Built-in + leader election | Built-in | Built-in | Built-in |
| **Flow control (parent-child)** | Planned (Phase 17) | FlowProducer | - | - |
| **Inspector / DLQ** | Built-in | QueueEvents + dashboard | Agendash | Built-in |
| **Retry + backoff** | 4 strategies + selective | Built-in | Exponential | retryLimit/delay |
| **Backend** | Redis, Memory | Redis | MongoDB | PostgreSQL |

## Key Differences

### vs BullMQ

BullMQ is the most established Redis-based queue. Taskora differs in:

- **Middleware** — BullMQ uses event hooks for cross-cutting concerns. Taskora has a composable Koa-style middleware pipeline where you can transform data before the handler and inspect results after.
- **Schema validation** — Taskora validates input/output with any Standard Schema library (Zod, Valibot, ArkType). BullMQ leaves this to userland.
- **Versioning** — BullMQ has a version field for compatibility checks. Taskora has full migration chains: bump version, add a migration function, deploy — old jobs in the queue are migrated automatically.
- **Testing** — BullMQ requires Redis (or redis-memory-server / ioredis-mock). Taskora ships `taskora/test` with an in-memory adapter and virtual time — no Docker, no mocks.
- **Batch collect** — Accumulating items into batches is a Pro (paid) feature in BullMQ. It's built into Taskora with three flush triggers (debounce, maxSize, maxWait).
- **Flows** — BullMQ has parent-child job flows via FlowProducer. Taskora doesn't have this yet (planned for Phase 17).

### vs Agenda

Agenda is a MongoDB-based scheduler, strong for cron-style recurring jobs:

- **Database** — Agenda is MongoDB-only. Taskora uses Redis (with PostgreSQL planned).
- **Focus** — Agenda is primarily a job scheduler. Taskora is a full task queue with scheduling as one feature among many.
- **Type safety** — Agenda v6 is TypeScript-native, but doesn't offer typed dispatch-to-result flows.

### vs pg-boss

pg-boss runs on PostgreSQL — useful if you don't want to add Redis:

- **Database** — pg-boss leverages PostgreSQL for queueing (SKIP LOCKED). Taskora uses Redis for performance-critical dequeue (BZPOPMIN, Lua scripts).
- **Throttle/dedup** — pg-boss has singleton-based throttling. Taskora offers separate debounce, throttle, and dedup primitives with configurable keys and windows.
- **Testing** — pg-boss requires a PostgreSQL instance. Taskora tests run in pure memory.

## Migration from BullMQ

| BullMQ | Taskora |
|---|---|
| `new Queue(name)` + `new Worker(name, fn)` | `createTaskora({ adapter })` + `taskora.task(name, fn)` |
| `queue.add(name, data)` | `task.dispatch(data)` |
| `job.waitUntilFinished(events)` | `await handle.result` |
| `worker.on("completed", fn)` | `task.on("completed", fn)` |
| `worker.concurrency` option | `taskora.task(name, { concurrency })` |
| `job.progress(value)` | `ctx.progress(value)` |
| `job.log(msg)` | `ctx.log.info(msg)` |
| `new FlowProducer()` | Coming in Phase 17 |
| `QueueScheduler` | Built-in, automatic |

### Steps

1. Create an instance with `createTaskora({ adapter: redisAdapter(...) })`
2. Define tasks with `taskora.task(name, { handler, ... })`
3. Replace `queue.add()` with `task.dispatch(data)`
4. Replace event listeners with `task.on()` or `taskora.on()`
5. Replace result polling with `await handle.result`
6. Move retry, concurrency, timeout config into task options
7. Add `await taskora.start()` / `await taskora.close()`
8. Write tests using `createTestRunner()` — no Redis needed

### ioredis connection config

BullMQ requires `maxRetriesPerRequest: null` and `enableReadyCheck: false` on the ioredis client — without them, a long reconnect can surface an uncaught `MaxRetriesPerRequestError` that kills the worker loop. **You can drop both options when moving to Taskora.** Taskora's blocking commands (`BZPOPMIN`, `XREAD BLOCK`) run inside retry loops in the worker, event reader, and job waiter, so a transient ioredis error is swallowed and retried on the next tick. ioredis defaults are safe. See [Adapters → ioredis driver](./guide/adapters.md#ioredis-driver-default) for the full explanation.
