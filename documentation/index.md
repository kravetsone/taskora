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
    details: Inferred types from handler to dispatch to result. No magic strings. If it compiles, it works.
    icon: "\U0001F512"
  - title: Retry & Backoff
    details: Fixed, exponential, linear, or custom strategies. Jitter, maxDelay, selective retryOn/noRetryOn.
    icon: "\U0001F504"
  - title: Koa-Style Middleware
    details: Onion model composition. App-level and per-task. Mutate data on the way in, inspect results on the way out.
    icon: "\U0001F9C5"
  - title: Built-in Scheduling
    details: Cron + intervals with distributed leader election. Missed run policies. Runtime management API.
    icon: "\u23F0"
  - title: Flow Control
    details: Debounce, throttle, deduplicate — all atomic via Lua scripts. Plus batch collect with multi-trigger flush.
    icon: "\U0001F6A6"
  - title: First-Class Testing
    details: "taskora/test with virtual time, in-memory adapter, run() for unit and execute() for integration."
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

Taskora is new, but it is not untested. Every commit and every pull request runs the **complete 300-test integration suite** against every supported runtime and every supported Redis driver — in parallel, in CI, on GitHub Actions:

| Runtime | Driver | Status |
|---|---|---|
| **Node 20** (LTS) | `taskora/redis` (ioredis) | 300 / 300 |
| **Bun 1.3+** | `taskora/redis/ioredis` | 300 / 300 |
| **Bun 1.3+** | `taskora/redis/bun` (native `Bun.RedisClient`) | 300 / 300 |
| **Deno 2.x** | `taskora/redis` (ioredis via `npm:` specifier) | 300 / 300 |

That is **1,200 real integration test runs against a live Redis on every push** — spanning Lua scripts, blocking dequeues, stream subscribers, pub/sub cancellation, distributed leader election, workflow DAG execution, schedulers, debounce / throttle / dedup flow control, and retention-aware DLQ management.

The matrix is not cosmetic. Turning it on exposed **five real bugs** that the old single-cell CI had been silently papering over — from a subtle `HELLO 2` + pub/sub interaction in Bun's native Redis client (filed upstream as [oven-sh/bun#29042](https://github.com/oven-sh/bun/issues/29042)) to a latent inspector-ordering flake that only happened to pass under ioredis because of pipeline timing luck. See [Cross-runtime CI](/testing/cross-runtime) for the full story.

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
