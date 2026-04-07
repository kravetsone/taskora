# Scheduling

Taskora includes a built-in distributed scheduler with leader election, interval/cron support, and missed run policies.

<SchedulerVisualizer />

## Interval Scheduling

```ts
// Inline on task definition
taskora.task("cleanup-expired", {
  schedule: { every: "1h" },
  handler: async (data, ctx) => {
    await db.deleteExpired()
  },
})
```

## Cron Scheduling

Requires `cron-parser` as a peer dependency:

::: pm-add cron-parser
:::

```ts
taskora.task("daily-report", {
  schedule: {
    cron: "0 9 * * 1-5",    // 9 AM weekdays
    timezone: "America/New_York",
  },
  handler: async (data, ctx) => {
    await generateDailyReport()
  },
})
```

## Named Schedules

Register schedules separately from task definitions:

```ts
taskora.schedule("nightly-cleanup", {
  task: "cleanup-expired",
  every: "6h",
  data: { olderThan: "30d" },
})

taskora.schedule("weekly-digest", {
  task: "send-digest",
  cron: "0 8 * * 1",
  timezone: "UTC",
})
```

## Duration Type

Taskora accepts durations as numbers (milliseconds) or human-readable strings:

```ts
type Duration = number | `${number}s` | `${number}m` | `${number}h` | `${number}d`
```

Examples: `"30s"`, `"5m"`, `"2h"`, `"1d"`, `30000`

## Leader Election

In a multi-worker deployment, only **one instance** runs the scheduler at a time. Taskora uses a Redis-based leader election (SET NX PX) with automatic failover.

- Leader acquires a lock with a configurable TTL (default 30s)
- Lock is renewed at regular intervals
- If the leader dies, another instance takes over automatically

```ts
const taskora = createTaskora({
  adapter: redisAdapter("redis://localhost:6379"),
  scheduler: {
    pollInterval: 1000,  // check for due schedules every 1s (default)
    lockTtl: 30_000,     // leader lock TTL (default 30s)
  },
})
```

## Overlap Prevention

By default, `overlap: false` — a new scheduled run won't dispatch if the previous run's job is still active.

```ts
taskora.task("sync-data", {
  schedule: {
    every: "5m",
    overlap: false, // default — skip if previous still running
  },
  handler: async (data, ctx) => {
    await syncExternalData()
  },
})
```

## Missed Run Policies

When the scheduler is temporarily down (deployment, crash, etc.), runs may be missed.

| Policy | Behavior |
|---|---|
| `"skip"` (default) | Ignore missed runs, resume from now |
| `"catch-up"` | Execute all missed runs in sequence |
| `"catch-up-limit:N"` | Execute at most N missed runs |

```ts
taskora.schedule("important-sync", {
  task: "sync-data",
  every: "1h",
  onMissed: "catch-up-limit:3",
})
```

## Runtime Management

```ts
// List all schedules
const schedules = await taskora.schedules.list()

// Pause a schedule
await taskora.schedules.pause("nightly-cleanup")

// Resume
await taskora.schedules.resume("nightly-cleanup")

// Update configuration
await taskora.schedules.update("nightly-cleanup", { every: "2h" })

// Remove
await taskora.schedules.remove("nightly-cleanup")

// Trigger immediately (bypasses schedule timing)
const handle = await taskora.schedules.trigger("nightly-cleanup")
```
