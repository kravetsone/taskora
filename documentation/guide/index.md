# Why Taskora

Taskora is a distributed task queue for Node.js — designed from scratch in TypeScript with the developer experience that modern backends deserve.

## Philosophy

1. **Task-centric, not queue-centric** — You define tasks, not queues. The queue is an implementation detail.
2. **Progressive disclosure** — `task.dispatch(data)` is enough to start. Retries, middleware, cron, monitoring unlock as you need them.
3. **Everything is composable** — Middleware chains, event listeners, and flow control options compose naturally.
4. **Type safety is DX** — If the types compile, the runtime works. No magic strings. No producer/consumer type drift.

## Features at a Glance

| Capability | How |
|---|---|
| Type-safe end-to-end | Inferred types from handler to dispatch to result |
| Schema validation | Any Standard Schema library (Zod, Valibot, ArkType) |
| Workflows | Chain, group, chord — type-safe task pipelines |
| Koa-style middleware | Onion model — app-level and per-task |
| Versioning & migrations | Bump version, add migration, deploy without draining |
| First-class testing | In-memory adapter + virtual time, no Docker needed |
| Flow control | Debounce, throttle, deduplicate — all atomic Lua |
| Batch collect | Accumulate items, flush on delay/maxSize/maxWait |
| Graceful cancellation | Instant via Redis pub/sub, with `onCancel` hooks |
| Distributed scheduling | Cron + intervals with leader election |
| Inspector & DLQ | Query jobs, retry failures, auto-trim old entries |

## Package Structure

```
taskora              — core engine, types, task API (zero DB deps)
taskora/redis        — Redis adapter (peer dep: ioredis)
taskora/memory       — in-memory adapter (zero DB deps)
taskora/test         — test runner (wraps memory adapter)
```

`ioredis` is an **optional peer dependency** — only required when using `taskora/redis`. The core package has zero database dependencies.
