---
title: Board — Admin Dashboard
description: taskora/board — batteries-included admin UI for inspecting tasks, jobs, workflows, schedules, and DLQ in real time. Hono-based, framework-agnostic, with SSE live updates.
---

# Board — Admin Dashboard

`taskora/board` is a full-featured, batteries-included admin dashboard for taskora. It ships as a pre-built React SPA served by a [Hono](https://hono.dev) backend, so there is **no build step** on your side — import it, mount it, done.

Unlike bull-board (which focuses on queues) or Flower (Celery-only), the taskora board is **task-centric** and exposes everything taskora actually does: workflow DAGs, schedules, migrations, flow control, retention, DLQ.

## Why a dashboard?

`taskora.inspect()` gives you programmatic access to every job, but during development and incident response you want eyes on the system. The board covers:

- **Observe** — real-time task counts, throughput charts, job timelines
- **Debug** — drill into individual jobs (data, result, error, logs, progress, retry history)
- **Visualize** — workflow DAG rendering with per-node state colors
- **Manage** — retry failed jobs, cancel active jobs, pause/resume schedules, clean queues, retry entire DLQ
- **Evolve** — version distribution per task, `canBumpSince` indicator for safe migration pruning

## Installation

`taskora/board` requires [`hono`](https://hono.dev) as a peer dependency.

::: pm-add hono
:::

The pre-built React SPA and its dependencies (Recharts, @xyflow/react, Tailwind) are **bundled inside the taskora package** — you do not install them yourself.

## Quick start

```ts
import { createTaskora } from "taskora"
import { redisAdapter } from "taskora/redis"
import { createBoard } from "taskora/board"

const taskora = createTaskora({
  adapter: redisAdapter("redis://localhost:6379"),
})

// ... define tasks, workers ...

const board = createBoard(taskora)
board.listen(3000)
// → taskora board listening on http://localhost:3000/board
```

Open `http://localhost:3000/board` in your browser. That's it.

## The `Board` interface

`createBoard(app, options?)` returns a `Board` object with four ways to serve the UI:

```ts
interface Board {
  app: Hono                                    // the raw Hono instance
  fetch: (req: Request) => Response | Promise<Response>  // Web standard fetch handler
  handler: (req, res) => void                  // Node.js-style handler (requires @hono/node-server)
  listen: (port: number) => void               // standalone server (Bun / Deno only)
}
```

Pick whichever fits your host:

::: code-group
```ts [Standalone (Bun / Deno)]
const board = createBoard(taskora)
board.listen(3000)
```

```ts [Bun.serve]
Bun.serve({
  port: 3000,
  fetch: board.fetch,
})
```

```ts [Deno.serve]
Deno.serve({ port: 3000 }, board.fetch)
```

```ts [Hono (mount under route)]
import { Hono } from "hono"

const app = new Hono()
app.route("/admin/taskora", board.app)
```

```ts [Express / Fastify / Koa (Node.js)]
import { serve } from "@hono/node-server"

// Standalone Node.js server
serve({ fetch: board.fetch, port: 3000 })

// Or as Express middleware (via @hono/node-server helpers)
import { createAdaptorServer } from "@hono/node-server"
const server = createAdaptorServer({ fetch: board.fetch })
expressApp.use("/admin/taskora", (req, res) => server.emit("request", req, res))
```
:::

::: tip Framework parity
Anything that speaks the Web `Request`/`Response` standard (Bun, Deno, Cloudflare Workers, Hono, Vercel Edge, …) can mount `board.fetch` directly. For Node.js-native frameworks (Express, Fastify, Koa, Next.js API routes), wrap it with [`@hono/node-server`](https://github.com/honojs/node-server).
:::

## Options

```ts
createBoard(taskora, {
  basePath: "/admin/taskora",         // default: "/board"
  readOnly: false,                    // hide mutation buttons + reject POST/PUT/DELETE
  auth: async (req) => { /* ... */ }, // per-request auth middleware
  title: "My Queue",                  // browser tab title
  logo: "/custom-logo.svg",           // header logo URL
  favicon: "/favicon.ico",
  theme: "auto",                      // "light" | "dark" | "auto"
  refreshInterval: 2000,              // stats polling fallback (ms) — SSE is primary
  redact: ["password", "apiKey", "ssn"],  // deep field redaction for job data/result
  cors: { origin: "*" },
  formatters: {
    data:   (data, task) => { /* custom render pre-processing */ return data },
    result: (result, task) => result,
  },
})
```

### Authentication

The `auth` hook runs on every API request. Return `undefined` to allow, or a `Response` to short-circuit:

```ts
createBoard(taskora, {
  auth: async (req) => {
    const token = req.headers.get("authorization")?.replace("Bearer ", "")
    if (!token || !(await verifyJwt(token))) {
      return new Response("Unauthorized", { status: 401 })
    }
    // return nothing → request proceeds
  },
})
```

Combine with your framework's own session middleware for a unified auth flow. For public demos or local dev, pair `readOnly: true` with no auth.

### Field redaction

Job payloads often contain secrets. The `redact` option walks every field in `data`, `result`, `error`, and `logs.meta`, masking any key whose name matches (case-insensitive):

```ts
createBoard(taskora, {
  redact: ["password", "secret", "token", "apiKey", "ssn", "creditCard"],
})
```

Nested objects and arrays are walked recursively — `user.auth.password` and `payments[0].creditCard` are both redacted. Redaction happens **on the server before the response leaves the process**, so secrets never touch the browser.

### Read-only mode

```ts
createBoard(taskora, { readOnly: true })
```

Mutation buttons are hidden in the UI and all `POST`/`PUT`/`DELETE` endpoints reject with `403`. Safe to expose behind a read-only employee SSO without risking accidental retries.

## What you get

### Overview dashboard

Global stat cards (waiting / active / delayed / failed / completed / cancelled / expired), a 24-hour throughput chart powered by Recharts, a task table with per-task counts and health indicators, and Redis server info (version, memory, uptime, connected state).

Throughput is backed by per-minute `INCR` counters stamped in `ack.lua` / `fail.lua` with a 24h TTL, so the chart is accurate without any external time-series database.

### Task detail

Per-task view with state tabs (waiting / active / delayed / retrying / failed / completed / cancelled / expired), a paginated job table, and bulk actions — retry-all and clean-by-age.

![Task detail view for send-email — stat cards, throughput chart, state tabs, and a job table showing completed jobs and retry errors](/board/task-detail.jpg)

### Job detail

Everything about a single job on one screen:

- **Timeline** — reconstructed from `ts` → `processedOn` → `finishedOn` (state transitions with absolute + relative timestamps)
- **Data / Result / Error / Logs** tabs
- **Progress bar** — renders numeric progress or arbitrary progress objects
- **Attempt history** — current attempt number vs `maxAttempts`
- **Actions** — retry, cancel (`handle.cancel()` equivalent)
- **Workflow link** — jumps to the parent workflow DAG if the job was part of one

### Workflow DAG visualization

Built on [`@xyflow/react`](https://reactflow.dev) with auto-layout (BFS layering). Nodes are colored by state, edges animate when the downstream node is active, and clicking a node opens its job detail view. Chains, groups, and chords all render correctly — including nested compositions. Cancel an entire workflow from the header and watch the cascade propagate.

### Schedule management

List all registered schedules with their cron/interval, next-run countdown (relative time display), last run status, and job ID. Actions: pause, resume, trigger-now, delete. The trigger-now button dispatches the task immediately without disturbing the scheduled cadence.

### DLQ view

Failed jobs grouped by error-message frequency so you can spot the top failure modes at a glance. Per-job retry and a global "retry all" button backed by the atomic `retryAllDLQ.lua` script (batched 100 at a time).

### Migrations view

Version distribution bar chart per task, showing how many jobs are queued or delayed at each `_v` version. The `canBumpSince` indicator tells you whether it is safe to raise `since` and drop old migrations — taskora checks queue / delayed / retrying sets for any job still stamped with a version below the proposed floor.

See [Versioning & Migrations](/features/versioning) for the underlying mechanics.

### Real-time updates (SSE)

The `/api/events` endpoint streams Server-Sent Events from `adapter.subscribe()` — every `active`, `completed`, `failed`, `retrying`, `cancelled`, `stalled`, and `progress` event flows to the browser in real time. A periodic `stats:update` frame refreshes stat cards every few seconds even when no jobs are moving.

SSE is the **primary** transport — `refreshInterval` polling only kicks in as a fallback if the EventSource disconnects.

### UX niceties

- **Dark / light / auto theme** via CSS custom properties (follows `prefers-color-scheme`)
- **Keyboard shortcuts** — `1`–`5` for top-level navigation, `/` for the global job-ID search bar
- **Global job search** — paste a job ID from a log line, land on the detail view

## REST API

Under the hood, the SPA talks to a plain REST API mounted at `${basePath}/api`. You can call these endpoints directly from your own tooling — they are not considered internal.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/overview` | Global stat cards, tasks, Redis info |
| `GET` | `/api/tasks/:task/jobs?state=&limit=&offset=` | Paginated jobs for a task |
| `GET` | `/api/tasks/:task/stats` | Queue counts for a task |
| `GET` | `/api/tasks/:task/migrations` | Version distribution + `canBumpSince` |
| `POST` | `/api/tasks/:task/retry-all` | Retry every failed job for a task |
| `POST` | `/api/tasks/:task/clean` | Trim completed/failed sets |
| `GET` | `/api/jobs/:jobId` | Full `JobDetailResponse` with timeline, logs, workflow link |
| `POST` | `/api/jobs/:jobId/retry` | Retry a single job (must be in failed/cancelled state) |
| `POST` | `/api/jobs/:jobId/cancel` | Cancel an active or waiting job |
| `GET` | `/api/schedules` | List all schedules |
| `POST` | `/api/schedules/:name/pause` | Pause a schedule |
| `POST` | `/api/schedules/:name/resume` | Resume a schedule |
| `POST` | `/api/schedules/:name/trigger` | Dispatch immediately without advancing next-run |
| `PUT` | `/api/schedules/:name` | Update schedule config |
| `DELETE` | `/api/schedules/:name` | Remove schedule |
| `GET` | `/api/workflows` | List active/recent workflows |
| `GET` | `/api/workflows/:workflowId` | Workflow DAG graph + per-node state |
| `POST` | `/api/workflows/:workflowId/cancel` | Cascade cancel workflow |
| `GET` | `/api/dlq` | Dead-letter queue jobs with grouping |
| `POST` | `/api/dlq/:jobId/retry` | Retry single DLQ entry |
| `POST` | `/api/dlq/retry-all` | Retry entire DLQ (batched) |
| `GET` | `/api/throughput` | 24h per-minute throughput buckets |
| `GET` | `/api/events` | Server-Sent Events stream |
| `GET` | `/api/config` | Static config (title, logo, theme, readOnly flag) |

All mutation endpoints respect `readOnly` and `auth`.

## Recipes

### Mount behind nginx / reverse proxy

Set `basePath` to match your upstream route so generated asset URLs are correct:

```ts
const board = createBoard(taskora, { basePath: "/internal/taskora" })
Bun.serve({ fetch: board.fetch, port: 3000 })
```

```nginx
location /internal/taskora/ {
  proxy_pass http://taskora-host:3000;
  proxy_set_header Host $host;
  proxy_buffering off;  # important for SSE
}
```

### Share a port with your API

If you already have a Hono app serving your public API, mount the board on a sub-route instead of running a second port:

```ts
import { Hono } from "hono"

const api = new Hono()
api.get("/health", (c) => c.json({ ok: true }))
// ... more routes ...

api.route("/admin/taskora", createBoard(taskora, {
  basePath: "/admin/taskora",
  auth: requireAdmin,
}).app)

Bun.serve({ fetch: api.fetch, port: 8080 })
```

### Redact secrets for a specific task only

`redact` is global, but `formatters` gives you per-task control:

```ts
createBoard(taskora, {
  formatters: {
    data: (data, task) => {
      if (task === "send-email") {
        const { body, ...rest } = data as any
        return { ...rest, body: "[REDACTED]" }
      }
      return data
    },
  },
})
```

### Expose only to internal network

```ts
createBoard(taskora, {
  readOnly: true,
  auth: async (req) => {
    const ip = req.headers.get("x-forwarded-for") ?? ""
    if (!ip.startsWith("10.") && !ip.startsWith("192.168.")) {
      return new Response("Forbidden", { status: 403 })
    }
  },
})
```

## Production checklist

- [ ] Set `auth` — never expose the board publicly without it
- [ ] Configure `redact` for any sensitive fields in job payloads
- [ ] Consider `readOnly: true` for broad internal visibility with narrow write access
- [ ] Mount behind HTTPS (board has no TLS — that's your proxy's job)
- [ ] If using nginx, disable `proxy_buffering` on the board location so SSE works
- [ ] Pin a stable `basePath` — changing it invalidates cached asset URLs in browsers

## See also

- [Inspector](/operations/inspector) — the programmatic API the board is built on
- [Retention & DLQ](/operations/dead-letter-queue) — what the DLQ view actually operates on
- [Monitoring](/operations/monitoring) — metrics pipelines for long-term observability (the board is not a replacement for Grafana)
- [Workflows](/features/workflows) — the DAG model the workflow view visualizes
- [Versioning & Migrations](/features/versioning) — what the migrations view reports on
