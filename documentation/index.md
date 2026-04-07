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
