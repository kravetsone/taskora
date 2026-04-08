---
layout: home

hero:
  name: Taskora
  text: The task queue Node.js deserves
  tagline: TypeScript-first, batteries-included distributed task queue for Node.js.
  image:
    src: /logo.svg
    alt: Taskora
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Why Taskora
      link: /guide/

features:
  - title: Type-Safe End-to-End
    details: "Inferred input and output types from handler signature all the way to handle.result. Standard Schema validation on the way in. Zero casts, zero magic strings."
    icon: "\U0001F512"
  - title: Retry & Backoff
    details: "Fixed, exponential, linear, or user-supplied backoff. Jitter, maxDelay, selective retryOn / noRetryOn. Per-task or per-dispatch override."
    icon: "\U0001F504"
  - title: Built-in Scheduling
    details: "Cron and intervals with distributed leader election across pods. Missed-run policies — skip, catch-up, catch-up-limit. Pause, resume, trigger, list at runtime."
    icon: "\u23F0"
  - title: Flow Control
    details: "Debounce, throttle, deduplicate, collect — all atomic via Lua scripts. Concurrency per key. Singleton tasks. Graceful pub/sub cancellation."
    icon: "\U0001F6A6"
  - title: First-Class Testing
    details: "taskora/test with virtual time and an in-memory adapter. runner.run() for handler unit tests, runner.execute() for the full pipeline. No Redis, no Docker."
    icon: "\U0001F9EA"
  - title: Batteries-Included Admin UI
    details: "taskora/board — live dashboard with workflow DAG, schedules, DLQ, migrations, throughput. Mount on any framework. No build step."
    icon: "\U0001F4CA"
    link: /operations/board
    linkText: Explore the board
---

<HeroBadges />

## Quick Start

::: pm-add taskora ioredis
:::

```ts
import { createTaskora } from "taskora"
import { redisAdapter } from "taskora/redis"

const taskora = createTaskora({
  adapter: redisAdapter("redis://localhost:6379"),
})

const sendEmailTask = taskora.task("send-email", async (data: { to: string; subject: string }) => {
  // your email logic here
  return { messageId: "abc-123" }
})

// Dispatch returns immediately — type-safe input and output
const handle = sendEmailTask.dispatch({ to: "user@example.com", subject: "Hello" })
const result = await handle.result // { messageId: "abc-123" }

// Start processing
await taskora.start()
```

## Battle-Tested Across Runtimes

[![Test](https://github.com/kravetsone/taskora/actions/workflows/test.yml/badge.svg)](https://github.com/kravetsone/taskora/actions/workflows/test.yml)

Taskora is new, but it is not untested. Every commit and every pull request runs the **complete 300-test integration suite** against every supported runtime and every supported Redis driver — in parallel, in CI, on GitHub Actions.

<TestingMatrix />

That is **1,500 real integration test runs against a live Redis on every push** — spanning Lua scripts, blocking dequeues, stream subscribers, pub/sub cancellation, distributed leader election, workflow DAG execution, schedulers, debounce / throttle / dedup flow control, and retention-aware DLQ management. See [Cross-runtime CI](/testing/cross-runtime) for the full matrix and how to reproduce any cell locally.

**What this means for you:**

- If your app runs on **Node**, you get the battle-tested default.
- If your app runs on **Bun**, you can drop the `ioredis` peer dependency entirely and use `taskora/redis/bun` — the native path is covered by the same 300 tests.
- If your app runs on **Deno**, the ioredis path works under Deno's npm compatibility layer — again, same 300 tests.
- A release cannot ship with any matrix cell red: the publish workflow is gated on green tests.

```bash
# Reproduce any matrix cell locally
bun run test:node          # Node   + ioredis
bun run test:bun:ioredis   # Bun    + ioredis
bun run test:bun           # Bun    + Bun.RedisClient
bun run test:deno          # Deno   + ioredis
```
