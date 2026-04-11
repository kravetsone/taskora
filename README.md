# taskora

[![Test](https://github.com/kravetsone/taskora/actions/workflows/test.yml/badge.svg)](https://github.com/kravetsone/taskora/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/taskora.svg)](https://www.npmjs.com/package/taskora)
[![license](https://img.shields.io/npm/l/taskora.svg)](./LICENSE)

**Task queue for Node.js. TypeScript-first, Redis-backed, batteries-included.**

Define tasks with handlers, dispatch jobs with full type inference, compose them into workflows, schedule them on cron or intervals, retry on failure, cancel in flight, inspect everything. Runs on Node, Bun, and Deno. Full docs at **[kravetsone.github.io/taskora](https://kravetsone.github.io/taskora)**.

> v0.x — the public API is stable enough to use in production (332 tests across the full feature surface, every commit runs on 5 runtime/driver combinations), but minor versions may still break API until 1.0.

## Install

```bash
npm install taskora ioredis
# or: pnpm add taskora ioredis
# or: bun add taskora ioredis
# or: yarn add taskora ioredis
```

`ioredis` is an optional peer dependency — required for the Redis adapter. On Bun you can skip it and use the native `Bun.RedisClient` driver via `taskora/redis/bun`.

## Quick start

```ts
import { createTaskora } from "taskora"
import { redisAdapter } from "taskora/redis"
import { z } from "zod"

const taskora = createTaskora({
  adapter: redisAdapter("redis://localhost:6379"),
})

// Define a task with full type inference from the schema
const sendEmailTask = taskora.task("send-email", {
  input: z.object({
    to: z.string().email(),
    subject: z.string(),
  }),
  retry: { attempts: 3, backoff: "exponential" },
  handler: async (data, ctx) => {
    ctx.log.info("sending", { to: data.to })
    return { messageId: await mailer.send(data) }
  },
})

// Start the worker loop
await taskora.start()

// Dispatch a job — typed end-to-end
const handle = sendEmailTask.dispatch({
  to: "alice@example.com",
  subject: "Welcome",
})

const { messageId } = await handle.result // typed!
```

## Features

**Task primitives**
- Named tasks with [Standard Schema](https://standardschema.dev) validation (Zod, Valibot, ArkType — any library)
- Typed `dispatch()` → typed `ResultHandle` → typed `await handle.result`
- [Task contracts](https://kravetsone.github.io/taskora/guide/contracts) — split producer and worker into separate processes without leaking handler code
- Configurable retry with fixed/linear/exponential backoff, jitter, `retryOn` / `noRetryOn` filters, and `ctx.retry()` for manual control
- Per-task concurrency, timeouts, middleware (Koa-style onion), and `onCancel` hooks

**Workflows (canvas)**
- `chain()` — sequential pipeline with type inference across steps
- `group()` — parallel execution with tuple result
- `chord()` — group header feeding a callback
- `.pipe()`, `.map()`, `.chunk()` — fluent composition and batch helpers
- Cascade cancellation, workflow TTL, full DAG model

**Flow control**
- [Debounce](https://kravetsone.github.io/taskora/features/flow-control#debounce) — replace-on-new-dispatch within a window
- [Throttle](https://kravetsone.github.io/taskora/features/flow-control#throttle) — rate-limit by key
- [Deduplicate](https://kravetsone.github.io/taskora/features/flow-control#deduplicate) — skip if a matching job already exists
- [TTL / expiration](https://kravetsone.github.io/taskora/features/ttl-expiration) — fail or discard jobs older than `maxAge`
- [Collect](https://kravetsone.github.io/taskora/guide/tasks#collect-tasks) — accumulate items into batches with debounce + maxSize + maxWait triggers
- [Singleton](https://kravetsone.github.io/taskora/features/flow-control#singleton) — one active job at a time, global across workers
- Per-key concurrency limits

**Scheduling**
- `app.schedule()` with interval (`"5m"`, `"1h"`) or cron expressions
- Leader election via Redis, automatic failover
- Missed-run policies: `"skip"` / `"catch-up"` / `"catch-up-limit:N"`
- Runtime management: pause, resume, trigger, list, update

**Cancellation** ([docs](https://kravetsone.github.io/taskora/features/cancellation))
- First-class `"cancelled"` state, distinct from `"failed"`
- `handle.cancel()` works on waiting, delayed, retrying, and active jobs
- Instant cancellation via Redis pub/sub (no polling)
- `onCancel` hook for cleanup, cascade cancellation for workflows

**Versioning & migrations** ([docs](https://kravetsone.github.io/taskora/features/versioning))
- Task `version` + migration chain (tuple or sparse record form)
- Worker silently nacks future versions, fails expired ones
- Inspector shows version distribution to check drain state before bumping `since`

**Observability**
- Typed events: `completed` / `failed` / `retrying` / `progress` / `active` / `stalled` / `cancelled`
- [Inspector API](https://kravetsone.github.io/taskora/operations/inspector): stats, jobs by state, cross-task `find(jobId)` with full timeline
- [Admin dashboard](https://kravetsone.github.io/taskora/operations/board) — `@taskora/board` (separate fullstack package) — React SPA with SSE live updates, workflow DAG visualisation, DLQ management
- Structured job logs via `ctx.log.info()` / `warn()` / `error()`
- Progress reporting via `ctx.progress()`

**Dead letter queue**
- `app.deadLetters.list()` / `retry()` / `retryAll()` — single and bulk recovery
- Configurable retention: `{ completed: { maxAge, maxItems }, failed: { ... } }`

**Runtime support**
- Node 20 (maintenance LTS) and Node 24 (current LTS)
- Bun 1.3+ with either `ioredis` or native `Bun.RedisClient`
- Deno 2.x via `npm:` specifier
- Zero runtime dependencies — everything is an optional peer

## Runs everywhere — tested everywhere

Every commit runs the full 300-test integration suite against a live Redis on every supported runtime × driver combination, in parallel on CI:

| Runtime | Driver | |
|---|---|---|
| Node 24 (current LTS) | `taskora/redis` (ioredis) | 300 / 300 |
| Node 20 (maintenance LTS) | `taskora/redis` (ioredis) | 300 / 300 |
| Bun 1.3+ | `taskora/redis/ioredis` | 300 / 300 |
| Bun 1.3+ | `taskora/redis/bun` (native `Bun.RedisClient`) | 300 / 300 |
| Deno 2.x | `taskora/redis` (via `npm:` specifier) | 300 / 300 |

**1,500 live-Redis test runs per push** — covering Lua scripts, blocking dequeues, pub/sub cancellation, distributed leader election, workflow DAGs, schedulers, flow control, and DLQ management. The release workflow is gated on every cell being green. See [Cross-runtime CI](https://kravetsone.github.io/taskora/testing/cross-runtime) for the full matrix and how to reproduce any cell locally.

## Package layout

```
taskora                 — core engine, Task API, workflows (zero DB deps)
taskora/redis           — Redis adapter, re-exports ./redis/ioredis
taskora/redis/ioredis   — explicit ioredis driver (Node, Bun, Deno)
taskora/redis/bun       — native Bun.RedisClient driver (Bun only, no peer deps)
taskora/memory          — in-memory adapter for development & tests
taskora/test            — test runner with virtual time

@taskora/board          — admin dashboard, separate fullstack package (peer deps: taskora, hono)
```

## Documentation

Full documentation at **[kravetsone.github.io/taskora](https://kravetsone.github.io/taskora)**.

- [Getting started](https://kravetsone.github.io/taskora/guide/getting-started)
- [Core concepts](https://kravetsone.github.io/taskora/guide/core-concepts)
- [Tasks](https://kravetsone.github.io/taskora/guide/tasks) — declaration, schemas, options
- [Contracts](https://kravetsone.github.io/taskora/guide/contracts) — producer/consumer split
- [Workflows](https://kravetsone.github.io/taskora/features/workflows) — chain, group, chord
- [Scheduling](https://kravetsone.github.io/taskora/features/scheduling)
- [Retry & backoff](https://kravetsone.github.io/taskora/features/retry-backoff)
- [Board (admin UI)](https://kravetsone.github.io/taskora/operations/board)

## AI-friendly documentation

taskora ships a curated [`/taskora` Agent Skill](https://kravetsone.github.io/taskora/guide/ai-skills) — a single SKILL.md that Claude Code, Cursor, Windsurf, Cline and 40+ other AI coding agents can consume directly. Install into any supported agent with one command:

```bash
npx skills add kravetsone/taskora/documentation/skills
```

The CLI detects which agents you have installed and syncs the skill into the right directory for each. See the [AI Skills guide](https://kravetsone.github.io/taskora/guide/ai-skills) for agent-specific install paths and manual installation.

## License

[MIT](./LICENSE) © kravetsone
