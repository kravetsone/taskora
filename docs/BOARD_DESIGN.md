# taskora/board — Dashboard Design Document

> In-house admin panel for observing tasks and managing the taskora runtime.

---

## 1. Goals & Non-Goals

### Goals

- **Observe**: Real-time view of all tasks, jobs, workflows, schedules, and queue health
- **Manage**: Retry failed jobs, cancel active jobs, pause/resume schedules, clean queues
- **Debug**: Drill into individual jobs — timeline, logs, progress, data, errors, retry history
- **Visualize**: Workflow DAG rendering (chains, groups, chords), throughput charts, queue depth over time
- **Zero config**: `app.board()` returns an HTTP handler — mount it and go
- **Universal**: Works with Express, Fastify, Hono, Koa, Bun.serve, Deno.serve, standalone

### Non-Goals

- Not a generic admin panel (no CRUD for arbitrary data — that's AdminJS territory)
- Not a replacement for Grafana/Datadog (no long-term metrics storage, no alerting)
- Not a multi-tenant SaaS dashboard (single app instance per board)
- No user management or RBAC built-in (bring your own auth middleware)

---

## 2. Competitive Analysis

| Feature | bull-board | Flower (Celery) | asynqmon | **taskora/board** |
|---|---|---|---|---|
| UI framework | React + Primer | Python + Tornado | React + Go | **TBD (see §4)** |
| Serving | Framework adapters | Standalone server | Standalone / embed | **Hono handler** |
| Real-time | Polling | Celery Events (WS) | Polling + Prometheus | **SSE (stream events)** |
| Job actions | Retry, delete, clean | Revoke, terminate, rate-limit | Retry, delete, archive | **Retry, cancel, clean, re-dispatch** |
| Workflow viz | None | None | None | **DAG graph (chains/groups/chords)** |
| Schedule mgmt | None (BullMQ repeatable) | Rate limits only | Scheduler view | **Full CRUD, pause/resume, trigger** |
| DLQ | Implicit via failed tab | No | Archive queue | **First-class DLQ view + retry/retryAll** |
| Auth | Middleware guard | HTTP Basic, OAuth | Read-only flag | **Middleware hook + read-only mode** |
| Customization | Logo, title, formatters | CLI flags | Dark mode | **Theme, branding, field redaction** |
| Migration insight | None | None | None | **Version distribution, canBumpSince** |
| Collect/Batch | None | None | None | **Batch accumulator visibility** |

**Key differentiator**: Workflow DAG visualization and schedule management — no competitor has this.

---

## 3. Architecture Options

### Option A: Hono + React SPA (recommended)

```
taskora/board
├── server/          — Hono app (REST API + SSE + static serving)
└── ui/              — React SPA (Vite build, bundled as static assets)
```

**Server**: Hono — universal HTTP framework. Works as Express middleware (`app.use("/board", honoAdapter)`), Fastify plugin, Bun.serve, Deno.serve, standalone.

**UI**: React SPA — Vite-built, pre-bundled at publish time. Served from the package as static files (embedded in the npm package). No build step for users.

| Pros | Cons |
|---|---|
| Hono is 14kb, runs everywhere | React adds ~140kb gzipped to the package |
| React has the best ecosystem for DAG viz (reactflow, elkjs) | Heavier than server-rendered |
| SPA allows rich interactivity (drag, zoom, filter) | Two build pipelines (server + UI) |
| bull-board validates this pattern | |
| Pre-built — zero setup for users | |

### Option B: Hono + HTMX (lightweight)

```
taskora/board
├── server/          — Hono app (HTML responses via JSX/templates)
└── (no separate UI) — HTMX partials, inline CSS, minimal JS
```

**Server**: Hono with JSX templates rendering HTML directly. HTMX for interactivity (lazy loading, form submissions, polling via `hx-trigger="every 2s"`).

| Pros | Cons |
|---|---|
| ~20kb total JS shipped to client | DAG visualization is very hard without a JS framework |
| No build step for UI at all | Limited interactivity (no drag, complex filtering) |
| Extremely fast page loads | HTMX SSE support is basic |
| Server-rendered = SEO friendly (irrelevant here) | Looks dated without significant CSS effort |

### Option C: Hono + Solid/Svelte SPA

Same as Option A but with Solid (~7kb) or Svelte (~2kb runtime).

| Pros | Cons |
|---|---|
| Dramatically smaller bundle | Smaller ecosystem for DAG/charting libs |
| Solid/Svelte are faster than React | Fewer contributors will know the stack |
| Modern DX | reactflow has no Solid/Svelte port |

### Option D: Hono + Preact SPA

React-compatible API at 3kb. Can use most React libraries.

| Pros | Cons |
|---|---|
| 3kb vs 140kb React | Some React libs break with Preact |
| Mostly compatible with reactflow | `compat` layer has edge cases |
| Familiar API for React developers | Community momentum is lower |

---

## 4. Recommended Architecture

**Hono + React SPA** (Option A) — with caveats:

- Use **Radix UI** for components (unstyled, accessible, tree-shakeable)
- Use **@xyflow/react** (reactflow v12) for workflow DAG visualization
- Use **Tailwind CSS** for styling (matches taskora project conventions)
- Use **Recharts** or **lightweight-charts** for throughput/queue-depth sparklines
- Use **Tanstack Query** for server state (polling, cache, optimistic updates)
- Use **SSE** for real-time events (not WebSocket — simpler, works through all proxies)

### Package entrypoint

```
taskora/board    — new subpath export
```

Stays in the same npm package. No separate `@taskora/board` package — fewer installs, version alignment guaranteed.

### Build pipeline

```
ui/                          — React SPA source (Vite)
├── src/
│   ├── pages/
│   ├── components/
│   ├── hooks/
│   └── lib/
├── vite.config.ts           — builds to src/board/static/
└── package.json             — UI dev dependencies (not shipped)

src/board/
├── index.ts                 — createBoard() factory, exports
├── api.ts                   — Hono routes (REST + SSE)
├── static/                  — pre-built SPA assets (git-ignored, built at publish)
└── adapters.ts              — framework integration helpers
```

At `npm publish` time, Vite builds the SPA into `src/board/static/`, which pkgroll includes in `dist/board/`. Users never run a build step.

---

## 5. Package Structure & Exports

```jsonc
// package.json additions
{
  "exports": {
    // ... existing exports ...
    "./board": {
      "types": "./dist/board/index.d.mts",
      "import": "./dist/board/index.mjs",
      "require": "./dist/board/index.cjs"
    }
  },
  "peerDependencies": {
    "hono": ">=4"  // new optional peer dep
  },
  "peerDependenciesMeta": {
    "hono": { "optional": true }
  }
}
```

### User-facing API

```typescript
import { taskora } from "taskora";
import { redisAdapter } from "taskora/redis";
import { createBoard } from "taskora/board";

const app = taskora({
  adapter: redisAdapter("redis://localhost:6379"),
});

// ... define tasks ...

const board = createBoard(app, {
  // All optional:
  basePath: "/board",           // default: "/board"
  readOnly: false,              // disable all mutations
  auth: (req) => true,          // guard function (access Hono Request)
  title: "My App Tasks",        // browser tab / header
  logo: "/logo.svg",            // custom logo URL
  redact: ["password", "token", "secret"],  // redact fields in job data display
  theme: "auto",                // "light" | "dark" | "auto"
  refreshInterval: 2000,        // polling fallback interval (ms)
});
```

### Framework integration

```typescript
// === Express ===
import express from "express";
const server = express();
server.use("/board", board.handler);  // Hono-to-Express via @hono/node-server

// === Fastify ===
import Fastify from "fastify";
const server = Fastify();
server.route({ url: "/board/*", method: ["GET", "POST", "PUT", "DELETE"],
  handler: board.fetch });  // Hono.fetch() is a standard Request → Response

// === Hono (native) ===
import { Hono } from "hono";
const server = new Hono();
server.route("/board", board.app);  // board.app is the Hono instance directly

// === Bun ===
Bun.serve({ fetch: board.fetch, port: 3000 });

// === Deno ===
Deno.serve(board.fetch);

// === Standalone ===
board.listen(3000);  // starts its own HTTP server
```

**`board` object shape:**

```typescript
interface Board {
  app: Hono;                              // raw Hono app (for Hono.route())
  fetch: (req: Request) => Response;      // Web standard fetch handler
  handler: NodeHandler;                   // Node.js (req, res) handler for Express/Koa
  listen: (port: number) => void;         // standalone mode
}
```

---

## 6. Server API Design (REST + SSE)

Base path: `{basePath}/api`

### 6.1 Overview

```
GET  /api/overview                — global stats, task list, health
```

**Response:**
```typescript
{
  tasks: Array<{
    name: string;
    stats: QueueStats;            // waiting, active, delayed, completed, failed, expired, cancelled
    config: {
      concurrency: number;
      timeout: number | null;
      retry: { attempts: number; backoff: string } | null;
      version: number;
      since: number;
    };
    paused: boolean;
  }>;
  totals: QueueStats;             // aggregated across all tasks
  redis: {                        // adapter info
    version: string;
    memory: string;
    connected: boolean;
    uptime: number;
  };
  workers: Array<{
    task: string;
    concurrency: number;
    running: number;              // active jobs in this worker
    status: "running" | "closing" | "stopped";
  }>;
  uptime: number;                 // app uptime in ms
}
```

### 6.2 Jobs

```
GET  /api/tasks/:task/jobs?state=<state>&limit=20&offset=0
GET  /api/jobs/:jobId                     — cross-task job lookup
POST /api/jobs/:jobId/retry               — retry from DLQ
POST /api/jobs/:jobId/cancel              — cancel active/waiting job
POST /api/tasks/:task/retry-all           — retry all failed
POST /api/tasks/:task/clean?state=<state>&before=<timestamp>
```

**Job detail response:**
```typescript
{
  id: string;
  task: string;
  state: JobState;
  data: unknown;                  // deserialized, redacted
  result: unknown | null;         // deserialized, redacted
  error: string | null;
  progress: number | object | null;
  attempt: number;
  maxAttempts: number;
  version: number;
  logs: LogEntry[];
  timeline: Array<{ state: string; at: number }>;
  timestamps: {
    created: number;
    processed: number | null;
    finished: number | null;
  };
  // Workflow context (if part of workflow)
  workflow: {
    id: string;
    nodeIndex: number;
  } | null;
  // Dispatch options used
  dispatch: {
    delay: number | null;
    priority: number | null;
    ttl: number | null;
    debounceKey: string | null;
    throttleKey: string | null;
    deduplicateKey: string | null;
    concurrencyKey: string | null;
  };
}
```

### 6.3 Schedules

```
GET    /api/schedules                      — list all schedules
POST   /api/schedules/:name/pause
POST   /api/schedules/:name/resume
POST   /api/schedules/:name/trigger        — manual trigger
PUT    /api/schedules/:name                — update config
DELETE /api/schedules/:name
```

**Schedule response:**
```typescript
{
  name: string;
  task: string;
  type: "interval" | "cron";
  expression: string;             // "30s" or "0 9 * * *"
  timezone: string | null;
  nextRun: number | null;
  lastRun: number | null;
  lastJobId: string | null;
  paused: boolean;
  overlap: boolean;
  onMissed: MissedPolicy;
}
```

### 6.4 Workflows

```
GET  /api/workflows?state=<state>&limit=20&offset=0
GET  /api/workflows/:workflowId            — full workflow detail + DAG
POST /api/workflows/:workflowId/cancel
```

**Workflow detail response:**
```typescript
{
  id: string;
  state: WorkflowState;           // running, completed, failed, cancelled
  createdAt: number;
  result: unknown | null;
  error: string | null;
  graph: {
    nodes: Array<{
      index: number;
      taskName: string;
      state: "pending" | "active" | "completed" | "failed" | "cancelled";
      jobId: string;
      deps: number[];
      result: unknown | null;
      error: string | null;
      // Derived for visualization:
      type: "task" | "group-member" | "chord-callback";
    }>;
    terminal: number[];
    edges: Array<{ from: number; to: number }>;
  };
  // Timing
  duration: number | null;         // total ms (if completed/failed)
}
```

### 6.5 DLQ (Dead Letters)

```
GET  /api/dlq?task=<name>&limit=20&offset=0
POST /api/dlq/:jobId/retry
POST /api/dlq/retry-all?task=<name>
```

### 6.6 Migrations

```
GET  /api/tasks/:task/migrations           — version distribution + canBumpSince
```

**Response:**
```typescript
{
  version: number;
  since: number;
  migrations: number;
  canBumpSince: number;
  queue: {
    oldest: number | null;
    byVersion: Record<number, number>;
  };
  delayed: {
    oldest: number | null;
    byVersion: Record<number, number>;
  };
}
```

### 6.7 Real-time Events (SSE)

```
GET  /api/events?tasks=task1,task2         — SSE stream
```

**Event types pushed over SSE:**
```
event: job:active
data: { "id": "abc", "task": "send-email", "attempt": 1 }

event: job:completed
data: { "id": "abc", "task": "send-email", "result": "ok", "duration": 150 }

event: job:failed
data: { "id": "abc", "task": "send-email", "error": "SMTP timeout", "willRetry": true }

event: job:retrying
data: { "id": "abc", "task": "send-email", "attempt": 2, "nextAttempt": 1712345678000 }

event: job:progress
data: { "id": "abc", "task": "send-email", "progress": 50 }

event: job:cancelled
data: { "id": "abc", "task": "send-email", "reason": "user request" }

event: job:stalled
data: { "id": "abc", "task": "send-email", "action": "recovered" }

event: stats:update
data: { "task": "send-email", "stats": { "waiting": 5, "active": 2, ... } }

event: workflow:completed
data: { "id": "wf-xyz", "duration": 3200 }

event: workflow:failed
data: { "id": "wf-xyz", "error": "node 3 failed" }

event: worker:ready
data: { "task": "send-email" }

event: worker:closing
data: { "task": "send-email" }
```

The SSE endpoint bridges `adapter.subscribe()` to the HTTP response stream. Each connected client gets its own subscription. On disconnect, the subscription is cleaned up.

Periodic `stats:update` events are pushed every `refreshInterval` ms (default 2s) so the overview dashboard stays live without client polling.

---

## 7. UI Views & Features

### 7.1 Overview Dashboard

The landing page. At-a-glance health.

```
┌─────────────────────────────────────────────────────────────┐
│  taskora board                               [My App Tasks] │
├─────────┬───────────────────────────────────────────────────┤
│         │                                                   │
│ Overview│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐       │
│ Tasks   │  │Wait │ │Activ│ │Delay│ │Fail │ │Done │       │
│ Schedules│  │  42 │ │  8  │ │ 120 │ │  3  │ │ 9.4k│       │
│ Workflows│  └─────┘ └─────┘ └─────┘ └─────┘ └─────┘       │
│ DLQ     │                                                   │
│         │  Throughput (last hour)                            │
│         │  ┌───────────────────────────────────────────┐    │
│         │  │ ▁▂▃▄▅▆▇█▇▆▅▄▃▂▁▁▂▃▄▅▆▇█▇▆▅▄▃▂▁        │    │
│         │  │ completed ── failed ── retrying            │    │
│         │  └───────────────────────────────────────────┘    │
│         │                                                   │
│         │  Tasks                                            │
│         │  ┌──────────────┬─────┬─────┬─────┬─────┬────┐   │
│         │  │ Name         │ Wait│ Act │ Fail│ Dlyd│ ▶  │   │
│         │  ├──────────────┼─────┼─────┼─────┼─────┼────┤   │
│         │  │ send-email   │  12 │  3  │  1  │  50 │ ▶  │   │
│         │  │ process-image│  30 │  5  │  2  │  70 │ ▶  │   │
│         │  │ sync-data    │   0 │  0  │  0  │   0 │ ▶  │   │
│         │  └──────────────┴─────┴─────┴─────┴─────┴────┘   │
│         │                                                   │
│         │  Workers                                          │
│         │  send-email: 3/5 active · process-image: 5/5 ·   │
│         │  Redis: 6.2.14 · Memory: 12.4MB · Uptime: 2d 3h  │
└─────────┴───────────────────────────────────────────────────┘
```

**Features:**
- Global stat cards (animated count-up on SSE updates)
- Throughput sparkline chart (last 1h/6h/24h toggle)
- Per-task summary table with mini-bars for queue depth
- Worker status badges
- Redis health indicator

### 7.2 Task Detail View

Drill into a single task's jobs.

```
GET /board/tasks/:taskName
```

**Features:**
- State tabs: Waiting | Active | Delayed | Completed | Failed | Expired | Cancelled
- Job table: ID (truncated), state badge, created, duration, attempt, actions
- Click row → Job Detail drawer/modal
- Bulk actions: retry all failed, clean completed, clean failed
- Sort by created/processed/finished timestamp
- Auto-refresh via SSE (new jobs appear at top)
- Task config summary (concurrency, timeout, retry, version)

### 7.3 Job Detail View

Full detail for a single job. Opens as a slide-over panel or dedicated page.

```
GET /board/jobs/:jobId
```

**Features:**
- **Header**: Job ID, state badge, task name, attempt X/Y
- **Timeline**: Visual horizontal timeline (created → active → retrying → active → completed)
  - Each state transition as a node on a horizontal track with timestamps
  - Duration between states shown on hover
- **Data tab**: Pretty-printed JSON of input data (with redaction)
- **Result tab**: Pretty-printed JSON of output result
- **Error tab**: Error message + stack trace (if failed), retry history
- **Logs tab**: Structured log entries (info/warn/error) with timestamps, filterable by level
- **Progress**: Progress bar or structured progress JSON
- **Actions**: Retry, Cancel (context-dependent)
- **Workflow link**: If part of a workflow, link to workflow view with this node highlighted
- **Metadata**: Version, dispatch options, concurrency key, debounce/throttle/dedup keys

### 7.4 Schedules View

```
GET /board/schedules
```

```
┌───────────────────────────────────────────────────────────┐
│ Schedules                                                  │
├───────────┬──────────┬──────────┬──────────┬──────────────┤
│ Name      │ Task     │ Schedule │ Next Run │ Actions      │
├───────────┼──────────┼──────────┼──────────┼──────────────┤
│ daily-sync│ sync-data│ 0 9 * * *│ in 2h 15m│ ⏸ Pause │▶ Trigger │
│ cleanup   │ cleanup  │ every 1h │ in 42m   │ ⏸ Pause │▶ Trigger │
│ report    │ report   │ 0 0 * * 1│ in 3d    │ ▶ Resume│▶ Trigger │
│           │          │          │ (paused) │              │
└───────────┴──────────┴──────────┴──────────┴──────────────┘
```

**Features:**
- Table of all schedules with status, next run countdown, last run info
- Pause / Resume toggle
- Manual Trigger button
- Edit schedule (change interval/cron, overlap, missed policy)
- Delete schedule
- Last job link (click to see the job)
- Relative time display ("in 2h 15m", "3m ago")

### 7.5 Workflow View

```
GET /board/workflows/:workflowId
```

**The differentiator.** Interactive DAG visualization.

```
┌─────────────────────────────────────────────────────────┐
│ Workflow wf-abc123             State: running  2.3s ago  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│   ┌─────────┐     ┌─────────┐     ┌───────────┐        │
│   │ resize  │────▶│ upload  │────▶│ notify    │        │
│   │ ✅ 120ms │     │ ⏳ active│     │ ⏸ pending │        │
│   └─────────┘     └─────────┘     └───────────┘        │
│                                                         │
│   Chain: resize → upload → notify                       │
│                                                         │
│   Node detail (click node):                             │
│   ┌─────────────────────────────────────────────┐       │
│   │ upload (node 1)                              │       │
│   │ Job: job-xyz789  ·  Attempt 1/3  ·  Active  │       │
│   │ Input: { "url": "s3://...", "size": "lg" }  │       │
│   │ Started: 1.2s ago                            │       │
│   └─────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────┘
```

**Features:**
- DAG rendered with @xyflow/react (auto-layout via elkjs/dagre)
- Node colors by state: green=completed, blue=active, gray=pending, red=failed, orange=cancelled
- Click node → side panel with job detail
- Animated edges (dashed for pending, solid for completed, pulsing for active)
- Support for all composition types:
  - **Chain**: linear left-to-right
  - **Group**: parallel vertical lanes
  - **Chord**: group converging to callback node
  - **Nested**: groups within chains, chains within chords
- Cancel workflow button
- Auto-updates via SSE as nodes complete

### 7.6 Workflows List

```
GET /board/workflows
```

**Features:**
- Table: ID, state badge, node count, created, duration, terminal task names
- Filter by state (running, completed, failed, cancelled)
- Click row → Workflow Detail
- Mini DAG preview (simplified graph thumbnail)

### 7.7 DLQ View

```
GET /board/dlq
```

**Features:**
- Failed jobs grouped by task (or flat list, toggle)
- Error message preview in the table row
- One-click retry per job
- "Retry All" per task or globally
- Error frequency: group by error message to identify patterns
- Failure trend sparkline

### 7.8 Migrations View

```
GET /board/tasks/:taskName/migrations
```

**Features:**
- Version distribution bar chart (how many jobs at each version in wait/active/delayed)
- Current version, `since` floor, `canBumpSince` recommendation
- Visual indicator: "safe to bump since to v3" (all older jobs drained)
- Per-version job counts for wait, active, delayed queues

---

## 8. Real-time Strategy

### Primary: SSE (Server-Sent Events)

```
Client  ─────── GET /api/events ──────▶  Server
        ◀────── event: job:completed ──  (bridges adapter.subscribe())
        ◀────── event: stats:update ───  (periodic push)
        ◀────── event: job:active ─────
```

**Why SSE over WebSocket:**
- Simpler protocol (HTTP/1.1 compatible, works through all proxies/load balancers)
- Automatic reconnection built into EventSource API
- Sufficient — dashboard is read-heavy, write actions use REST POST
- One-directional push is all we need for live updates

**Implementation:**
- Server subscribes to `adapter.subscribe(tasks, handler)` per SSE client
- On event, serializes and pushes to SSE stream
- On client disconnect, unsubscribes from adapter
- `stats:update` pushed on timer (configurable, default 2s)
- Heartbeat `:ping` every 15s to keep connection alive through proxies

### Fallback: Polling

If SSE is unavailable (corporate proxy issues), the UI falls back to Tanstack Query polling at `refreshInterval` intervals. The REST API is the same either way — SSE just avoids the polling overhead.

---

## 9. Authentication & Security

Two shapes for `auth` (discriminated union, not combinable):

1. **Session config** — batteries-included login/password flow with server-rendered login page and signed session cookie. Added in the Phase 18 follow-up after the initial board ship.
2. **Legacy function hook** — per-request middleware for callers that ship their own JWT / OAuth / framework session. Unchanged, preserved for backward compatibility.

### Approach A — Session auth (`BoardAuthConfig`)

```typescript
const board = createBoard(app, {
  auth: {
    cookiePassword: process.env.BOARD_COOKIE_SECRET!,  // min 32 chars
    authenticate: async ({ username, password }) =>
      username === "admin" && password === process.env.BOARD_PASSWORD
        ? { id: "admin" }
        : null,
    cookieName: "taskora_board_session",  // optional, shown as default
    sessionTtl: "7d",                     // optional, shown as default
  },
});
```

**Design goals**: zero new dependencies, works on every adapter (including memory), no Redis session store, no React rebuild for the login page.

**Cookie format**. The session payload is a plain JSON object `{ user, exp }` where `exp` is either a ms-since-epoch absolute expiry or `null` (meaning "no expiry"). The JSON is base64-encoded, then HMAC-SHA256-signed via Hono's built-in `setSignedCookie` helper (Web Crypto under the hood). On read, `getSignedCookie` verifies the signature; if `exp` is a number we double-check `exp > Date.now()`. A signed-but-expired cookie is treated as unauthenticated, not as an error.

**Cookie attributes**: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` set automatically when the request URL is HTTPS. `Max-Age` is set only when `sessionTtl` is a positive Duration — otherwise the cookie is a browser-session cookie (cleared on browser close).

**`sessionTtl` default: disabled.** The library used to default to `"7d"`, but disabling expiry by default matches the "admin dashboard for a small team" use case better — you sign in once and stay signed in until you explicitly log out or close the browser. Callers who need rolling expiry opt in with `sessionTtl: "7d"` (or any Duration). Passing `sessionTtl: false` is the same as omitting it.

**Routes** added when session auth is enabled (all under `basePath`):
- `GET /login` — server-rendered HTML login page (see `src/board/auth/login-page.ts`). Not a React route — a single template literal with inline CSS. This is deliberate: rebuilding the SPA to add a login screen would have forced every caller to ship a rebuilt `static/` on every auth change.
- `POST /auth/login` — parses the form body, calls `authenticate`, sets the cookie, and redirects. Open-redirect-safe: `redirect` query param must start with `basePath` and contain no `//` or `\\`, otherwise it falls back to `basePath`.
- `POST /auth/logout` — clears the cookie and redirects to `/login`.

**Guard middleware** (`createAuthGuard`) has two modes because the API and the SPA handler need different failure responses:
- `"api"` mode (installed on the API router, scoped to `/api/*`) → `401 {"error":"Unauthorized"}`
- `"html"` mode (wraps the static handler) → `302 -> /board/login?redirect=<path>`

Both modes share `readSession`. Auth routes (`/login`, `/auth/login`, `/auth/logout`) are excluded by path so the middleware cannot cause an infinite redirect.

**Mount order** inside `createBoard`:
1. Auth routes (unguarded)
2. API sub-app (installs its own API-mode guard on `/api/*`)
3. Static handler (wrapped with the HTML-mode guard)

The API guard is scoped to `/api/*` — not `/*` — so an unauthenticated `GET /board/` request is not short-circuited inside the API sub-app and correctly falls through to the static handler's HTML guard, which redirects to the login page.

**`cookiePassword` length check**: `createBoard` throws synchronously if the secret is shorter than 32 characters. HMAC-SHA256 can accept arbitrary-length keys but short secrets weaken the signing substantially; the explicit check makes this a loud failure instead of silent weakness.

**Why no session store?** Stateless signed cookie keeps the feature dependency-free and adapter-neutral. The cost is that logout only clears the *client* cookie — a cookie that was exfiltrated before logout remains valid until its `exp`. For the "admin dashboard for the team" threat model this is acceptable; callers with stricter requirements can keep using the legacy function hook and plug their session store in themselves.

**Why no CSRF token?** `SameSite=Lax` already blocks cross-site POSTs, and every mutating endpoint is POST/PUT/DELETE. Adding an explicit CSRF token would double the surface area for near-zero real gain under the assumed threat model.

**Why no password hashing / rate limiting / lockout?** The caller's `authenticate` function owns credential verification. The board has no opinion on whether credentials come from an env var, bcrypt-hashed DB rows, LDAP, or an SSO IdP — layering these inside the board would either constrain the user or leak complexity. Documented explicitly as a non-goal.

### Approach B — Legacy function hook (`BoardAuthLegacyFn`)

```typescript
const board = createBoard(app, {
  auth: async (req: Request) => {
    const token = req.headers.get("authorization");
    if (!token || !verify(token)) {
      return new Response("Unauthorized", { status: 401 });
    }
    // return void = allowed
  },
});
```

Unchanged from the original Phase 18 ship. Runs per-request on `/api/*` only. **Does not guard the SPA HTML or static assets** — the SPA remains publicly downloadable. The assumption is that callers using the legacy form have their own front-door auth (reverse proxy, gateway, framework middleware) and are wiring the function form as an extra per-request check. Preserved exactly to avoid breaking anyone who already shipped JWT integration.

### Discriminated union

`src/board/types.ts` exports an `isBoardAuthConfig(v)` type guard. `BoardOptions.auth` is `BoardAuthLegacyFn | BoardAuthConfig`. Both `createApi` and `createBoard` dispatch on the guard to pick the right code path.

### Read-only mode

```typescript
const board = createBoard(app, {
  readOnly: true,
});
```

Disables all mutation endpoints (POST/PUT/DELETE). The UI hides action buttons. API returns 403 on mutation attempts.

### Field redaction

```typescript
const board = createBoard(app, {
  redact: ["password", "token", "secret", "apiKey", "creditCard"],
});
```

Deep-redacts matching keys in job `data` and `result` before sending to the UI. Values replaced with `"[REDACTED]"`. Applied server-side — sensitive data never reaches the browser.

### CORS

Board API sets CORS headers only for same-origin by default. Configurable:

```typescript
const board = createBoard(app, {
  cors: { origin: "https://admin.myapp.com" },
});
```

---

## 10. Adapter Additions

The current Inspector/Adapter API covers most needs. New adapter methods needed:

```typescript
interface Adapter {
  // === Existing (sufficient) ===
  // listJobDetails, getJobDetails, getQueueStats, getState, getResult, getError
  // getProgress, getLogs, retryFromDLQ, retryAllFromDLQ, trimDLQ, trimCompleted
  // getVersionDistribution, subscribe, cancel

  // === New ===

  /** Bulk clean jobs from a state set older than `before` timestamp. */
  cleanJobs(task: string, state: JobState, before: number, limit: number): Promise<number>;

  /** Get Redis server info (version, memory, uptime). */
  getServerInfo(): Promise<{
    version: string;
    usedMemory: string;
    uptime: number;
    connected: boolean;
  }>;

  /** List workflows with pagination. */
  listWorkflows(
    state?: WorkflowState,
    offset?: number,
    limit?: number
  ): Promise<Array<{
    id: string;
    state: WorkflowState;
    createdAt: number;
    nodeCount: number;
    terminalTasks: string[];
  }>>;

  /** Get full workflow detail including per-node state and results. */
  getWorkflowDetail(workflowId: string): Promise<{
    id: string;
    state: WorkflowState;
    createdAt: number;
    graph: WorkflowGraph;
    nodes: Array<{
      index: number;
      state: string;
      result: string | null;
      error: string | null;
      jobId: string;
    }>;
    result: string | null;
    error: string | null;
  } | null>;

  /** Get throughput metrics for the last N time buckets. */
  getThroughput(
    task: string | null,
    bucketSize: number,      // ms (e.g., 60_000 for 1-minute buckets)
    count: number            // number of buckets
  ): Promise<Array<{
    timestamp: number;
    completed: number;
    failed: number;
  }>>;
}
```

### Throughput tracking

For the throughput chart, we need counters. Two options:

**Option A: Stream-derived (no new storage)**
Count events from the existing `:events` stream by scanning `XRANGE` with time bounds. Works for small windows but O(n) per scan.

**Option B: HyperLogLog/counter buckets (new storage, recommended)**
```
taskora:<pfx>:metrics:<task>:completed:<minute_ts>  — INCR on ack
taskora:<pfx>:metrics:<task>:failed:<minute_ts>     — INCR on fail
```
TTL 24h on each key. O(1) reads. `getThroughput()` pipelines MGET across the range.

**Recommendation**: Option B. Minimal storage overhead (~2 keys per task per minute, auto-expire), O(1) reads, works at any scale. The INCR calls piggyback on existing ack/fail Lua scripts.

---

## 11. Customization & Theming

### Branding

```typescript
createBoard(app, {
  title: "Acme Task Queue",      // header + tab title
  logo: "/acme-logo.svg",        // URL or inline SVG
  favicon: "/favicon.ico",
  theme: "dark",                  // "light" | "dark" | "auto" (system)
});
```

### Field formatters

```typescript
createBoard(app, {
  formatters: {
    data: (data, taskName) => {
      // Transform data before display (e.g., truncate large fields)
      if (taskName === "process-image") {
        return { ...data, buffer: `<${data.buffer.length} bytes>` };
      }
      return data;
    },
    result: (result, taskName) => result,
    duration: (ms) => `${(ms / 1000).toFixed(1)}s`,
  },
});
```

### CSS custom properties (theme override)

The UI exposes CSS custom properties on `:root` for advanced theming:

```css
:root {
  --board-bg: #0a0a0a;
  --board-surface: #171717;
  --board-border: #262626;
  --board-text: #fafafa;
  --board-text-muted: #a1a1aa;
  --board-primary: #3b82f6;
  --board-success: #22c55e;
  --board-danger: #ef4444;
  --board-warning: #f59e0b;
  /* ... */
}
```

---

## 12. Implementation Phases

### Phase 18a: Board Server (API layer)

**Goal**: REST API + SSE, no UI yet. Testable with curl.

**Tasks:**
1. `src/board/index.ts` — `createBoard()` factory, Board interface
2. `src/board/api.ts` — Hono routes for all endpoints (§6)
3. `src/board/sse.ts` — SSE stream bridging adapter.subscribe()
4. `src/board/redact.ts` — deep field redaction utility
5. New adapter methods: `cleanJobs`, `getServerInfo`, `listWorkflows`, `getWorkflowDetail`
6. Throughput metric counters (INCR in ack/fail Lua)
7. `getThroughput()` adapter method
8. Framework adapter helpers (Express, standalone)
9. Integration tests: API endpoints return correct data
10. `package.json`: add `./board` export, `hono` peer dep

**Ship**: API-only. Users can build custom UIs against the REST API.

### Phase 18b: Board UI (React SPA)

**Goal**: Full dashboard UI.

**Tasks:**
1. Vite + React + Tailwind setup in `ui/`
2. Tanstack Query provider + SSE hook
3. Overview dashboard (stats cards, throughput chart, task table)
4. Task detail view (state tabs, job table, bulk actions)
5. Job detail panel (timeline, data/result/error/logs tabs)
6. Build pipeline: Vite → `src/board/static/`
7. Static file serving from Hono

### Phase 18c: Workflows & Schedules UI

**Goal**: DAG visualization, schedule management.

**Tasks:**
1. @xyflow/react integration for workflow DAG
2. Auto-layout with elkjs (hierarchical for chains, layered for groups)
3. Workflow list view with filters
4. Workflow detail view with interactive graph
5. Schedule management UI (pause/resume/trigger/edit/delete)
6. DLQ view with error grouping

### Phase 18d: Polish & Extras

**Goal**: Production-ready.

**Tasks:**
1. Dark/light/auto theme
2. Keyboard shortcuts (j/k navigation, r=retry, c=cancel)
3. Search: global job ID search
4. Responsive layout (mobile-friendly)
5. SSE reconnection with backoff
6. Loading skeletons, error boundaries
7. Migration insight view
8. Export: download job data as JSON
9. Performance: virtualized tables for large job lists

---

## 13. Open Questions

### Q1: Separate package or subpath export?

**Current recommendation**: Subpath `taskora/board`.

Pros: single install, guaranteed version compatibility, no publish coordination.

Cons: increases base package size by ~200kb (pre-built SPA assets). Users who never use the board still download the assets.

**Alternative**: `@taskora/board` as a separate package. Cleaner separation but more publishing overhead.

→ Decision: start as subpath. Extract later if package size becomes a concern.

### Q2: Hono as peer dep or bundled?

**Current recommendation**: Peer dep (`"hono": ">=4"`).

Hono is 14kb. Bundling it avoids install friction but risks version conflicts if the user also uses Hono. Peer dep is standard practice for framework dependencies.

→ Decision: optional peer dep (same as ioredis). Only required if using `taskora/board`.

### Q3: Throughput storage strategy?

See §10. Counter buckets (Option B) recommended. Low overhead, O(1) reads, auto-expire.

→ Needs benchmarking: how many INCR calls per second in high-throughput scenarios? (Answer: Redis handles millions of INCR/s — this is not a concern.)

### Q4: Maximum SSE connections?

Each SSE client creates one `adapter.subscribe()` connection. For Redis, each subscription uses a dedicated connection for XREAD BLOCK.

Mitigation: share a single XREAD subscription across all SSE clients (fan-out in the board server). Only one Redis connection for all dashboard viewers.

→ Implementation detail for Phase 18a.

### Q5: Job data size limits?

Large job payloads (multi-MB) should not be sent in list views. Strategy:
- List views: only metadata (no data/result fields)
- Detail view: full data on demand
- Configurable max display size (truncate with "show raw" link)

---

## 14. Dependencies (new)

```
Production (peer):
  hono >= 4                    — HTTP framework (required for taskora/board)

UI build-time (dev only, not shipped as deps):
  react, react-dom             — SPA framework
  @xyflow/react                — DAG visualization
  @radix-ui/themes             — accessible UI components
  @tanstack/react-query        — server state management
  tailwindcss                  — utility CSS
  recharts                     — charts
  vite                         — bundler
```

All UI dependencies are build-time only. The published package contains pre-built static assets — users install zero UI dependencies.

---

## 15. Summary

```
taskora/board = Hono server + React SPA + SSE real-time

Server: Hono (universal HTTP handler)
├── REST API (overview, jobs, schedules, workflows, DLQ, migrations)
├── SSE stream (real-time events from adapter.subscribe)
├── Auth middleware hook
└── Static file serving (pre-built SPA)

UI: React + Tailwind + @xyflow/react
├── Overview (stats, throughput, task table, workers)
├── Task detail (job list by state, bulk actions)
├── Job detail (timeline, data, result, logs, errors)
├── Workflows (DAG visualization, cancel)
├── Schedules (pause, resume, trigger, edit)
├── DLQ (error grouping, retry, retry all)
└── Migrations (version distribution)
```

Unique advantages over bull-board:
1. **Workflow DAG visualization** — no competitor has this
2. **Schedule management** — full CRUD, not just viewing
3. **Task-centric design** — matches taskora's philosophy
4. **SSE real-time** — no polling, instant updates
5. **Universal mount** — Express, Fastify, Hono, Bun, Deno, standalone
6. **Field redaction** — sensitive data never reaches the browser
7. **Migration insight** — version distribution, safe-to-bump-since
