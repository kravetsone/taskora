# taskora/board — Ideas Pool

Comparison with Celery Flower + new ideas specific to taskora.

---

## What Flower has that we don't (yet)

| Flower feature | Status in taskora/board | Priority |
|---|---|---|
| **Worker management page** — list workers, online/offline, pool size, active tasks, CPU/memory | Missing | High |
| **Worker actions** — restart, shutdown, grow/shrink pool, add/remove queues | Missing (need Worker registry) | Medium |
| **Task rate limiting** — set per-task rate limits from UI | Missing | Low |
| **Task revoke/terminate** — revoke by task name (not just job ID) | We have cancel by ID, but not by name/pattern | Medium |
| **Broker monitoring** — queue sizes, message rates, consumer counts | Partial (we show Redis info but not queue-level broker metrics) | Medium |
| **Persistent state** — save dashboard state across restarts | Missing | Low |
| **Task columns customization** — user picks which columns to show | Missing | Medium |
| **Prometheus /metrics endpoint** — scrape-ready metrics export | Missing | High |
| **Task result inspection** — view result inline in task list | We have it in job detail, not in list | Low |
| **Auto-refresh toggle** — user can pause/resume live updates | Missing | Medium |
| **Task ETA/countdown display** — show when delayed tasks will run | We show delayed but not the countdown timer | Low |

---

## New ideas (taskora-specific)

### Tier 1 — High impact, fills real gaps

#### 1. Worker Registry & Status Page
Show all connected workers: which tasks they serve, concurrency, active job count, uptime, stall check status. Requires a worker heartbeat mechanism (workers register themselves in Redis on start, deregister on close).

```
Workers (4 online)
┌─────────────┬──────────┬─────────┬────────┬─────────┐
│ Worker       │ Tasks    │ Active  │ Conc.  │ Uptime  │
├─────────────┼──────────┼─────────┼────────┼─────────┤
│ worker-1     │ send-email│ 3/5    │ 5      │ 2h 15m  │
│ worker-2     │ send-email│ 4/5    │ 5      │ 2h 15m  │
│ worker-3     │ process-* │ 2/2    │ 2      │ 45m     │
│ worker-4     │ sync-data │ 0/1    │ 1      │ 2h 15m  │
└─────────────┴──────────┴─────────┴────────┴─────────┘
```

#### 2. Prometheus /metrics Endpoint
Export metrics in Prometheus format at `/board/metrics`:
- `taskora_jobs_total{task, state}` — counter
- `taskora_jobs_active{task}` — gauge
- `taskora_jobs_duration_seconds{task}` — histogram
- `taskora_queue_depth{task, state}` — gauge
- `taskora_workflow_total{state}` — counter
- `taskora_redis_memory_bytes` — gauge

#### 3. Job Re-dispatch
"Retry with same data" button — not just DLQ retry (which re-enqueues), but dispatch a brand new job with the same input data. Useful for debugging.

#### 4. Bulk Actions
- Select multiple jobs → retry/cancel/delete
- Select all failed by error pattern → retry matching
- "Clean all completed older than X" with a date picker

#### 5. Error Pattern Analysis
Group failed jobs by error message (normalized — strip IDs/timestamps). Show frequency, first/last seen, affected tasks. Like Sentry but for task errors.

```
Error Patterns (last 24h)
┌──────────────────────────────────────┬───────┬──────────┬─────────────┐
│ Pattern                               │ Count │ Tasks    │ Last Seen   │
├──────────────────────────────────────┼───────┼──────────┼─────────────┤
│ SMTP connection refused for *         │ 47    │ send-email│ 2m ago      │
│ HTTP 503 from *                       │ 128   │ webhook  │ 30s ago     │
│ Image corrupt or unsupported format   │ 12    │ process-*│ 5m ago      │
└──────────────────────────────────────┴───────┴──────────┴─────────────┘
```

#### 6. Latency Percentiles
P50, P95, P99 processing time per task. Derived from completed job timestamps (processedOn → finishedOn). Show as sparkline or table.

### Tier 2 — Nice to have, polish

#### 7. Live Job Log Streaming
When viewing an active job, stream logs in real-time via SSE. Currently logs are fetched on page load — but for long-running tasks you want to tail them live.

#### 8. Job Data Diff
For retried jobs: show what changed between attempts (if data was modified by middleware). Useful for debugging migration/transform issues.

#### 9. Notification Webhooks
Configure alerts from the board UI: "notify me when DLQ count > 100", "notify when task X has > 10 failures in 5 minutes". Sends to Slack/Discord/webhook.

#### 10. Workflow Templates
Save workflow compositions as named templates. Re-dispatch a workflow from the UI by selecting a template and providing input data.

#### 11. Cost Estimation
If user configures "cost per job" per task, show estimated cost on the overview. Useful for teams billing by compute.

#### 12. Dark/Light Theme Toggle in UI
Currently theme is set at server config. Add a toggle button in the sidebar so users can switch without restarting.

#### 13. Job Timeline Flame Chart
For workflows: render a flame chart showing when each node started/finished. Horizontal axis = time, rows = nodes. Shows parallelism and bottlenecks visually.

#### 14. Export & API Docs
- Export job data as JSON/CSV from the UI
- Built-in API reference page (OpenAPI spec rendered inline)

#### 15. Keyboard Power-User Mode
- `j/k` — navigate job list
- `r` — retry selected
- `c` — cancel selected
- `Enter` — open detail
- `Esc` — close detail/go back
- `?` — show shortcuts overlay

#### 16. Multi-App Support
Mount multiple taskora apps on one board (e.g., different services sharing a Redis). Tab per app, or unified view with app prefix.

### Tier 3 — Future / experimental

#### 17. AI-Powered Error Triage
Feed error messages + job data to an LLM, suggest likely root cause. "This looks like a DNS resolution failure — check if the host is reachable."

#### 18. Replay Mode
Record all events for a time window, replay them in the UI at adjustable speed. Like a DVR for your task queue. Useful for post-incident review.

#### 19. Dependency Graph Discovery
Auto-detect task relationships from actual execution patterns (not just explicit workflows). "send-email is almost always dispatched after process-payment."

#### 20. SLA Tracking
Define SLAs per task: "send-email must complete within 5s, 99.9% of the time". Board shows current SLA compliance with red/green indicators.

---

## Comparison summary

| Area | Flower | bull-board | **taskora/board** |
|---|---|---|---|
| **Live updates** | WebSocket events | Polling | **SSE + cache patch** |
| **Workers** | Full page + actions | None | Planned (Tier 1) |
| **Workflows** | None | None | **DAG viz + names** |
| **Schedules** | None | Repeatable jobs only | **Full CRUD + expandable** |
| **DLQ** | None | Failed tab | **Dedicated view + error groups** |
| **Migrations** | None | None | **Version distribution** |
| **Metrics export** | Prometheus | None | Planned (Tier 1) |
| **Auth** | OAuth + Basic | Middleware guard | **Middleware hook** |
| **Error analysis** | None | None | Planned (Tier 1) |
| **Latency tracking** | None | None | Planned (Tier 1) |
| **Job re-dispatch** | None | None | Planned (Tier 1) |
| **Theme** | Light only | Light only | **Dark/light/auto** |
| **Keyboard shortcuts** | None | None | **1-5 nav, / search** |
| **Per-task memory** | None | None | **Key count + memory** |
| **Customizable columns** | Yes | No | Planned (Tier 2) |

### What we already beat Flower on:
- Workflow DAG visualization (Flower has zero workflow support)
- Schedule management (Flower can only set rate limits)
- SSE real-time (no polling flicker)
- Per-task Redis memory/key stats
- Dark mode
- Migration version distribution
- Field redaction (Flower has none)

### Where Flower still wins:
- Worker management (restart, shutdown, pool resize)
- Prometheus metrics export
- Broker-level monitoring
- Battle-tested in production for 10+ years
- OAuth built-in
