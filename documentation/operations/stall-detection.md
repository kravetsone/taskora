# Stall Detection

Taskora detects jobs that stop responding (worker crash, OOM, network partition) and either recovers or fails them.

## How It Works

Stall detection uses a **two-phase** approach:

1. **Phase 1 — Snapshot:** Record all active job IDs into a stalled candidates set
2. **Phase 2 — Resolve:** On the next check, any job still in the candidates set (not removed by `extendLock`) is truly stalled

Between phases, healthy workers call `extendLock()` which removes their jobs from the candidates set (via `SREM`). Only genuinely stalled jobs remain.

## Configuration

```ts
taskora.task("process-data", {
  stall: {
    interval: 30_000, // check every 30 seconds (default)
    maxCount: 1,       // max stalled count before failing (default: 1)
  },
  handler: async (data, ctx) => { /* ... */ },
})
```

### `maxCount` Behavior

| `maxCount` | First stall | Second stall |
|---|---|---|
| `1` (default) | Re-queue (recover) | Move to failed |
| `2` | Re-queue | Re-queue |
| `0` | Move to failed immediately | — |

The `stalledCount` is tracked in the job hash (`HINCRBY`).

## App-Level Defaults

```ts
const taskora = createTaskora({
  adapter: redisAdapter("redis://localhost:6379"),
  defaults: {
    stall: { interval: 15_000, maxCount: 2 },
  },
})
```

## Events

```ts
task.on("stalled", ({ id, count, action }) => {
  console.log(`Job ${id} stalled (count: ${count}, action: ${action})`)
  // action: "recovered" — re-queued for another attempt
  // action: "failed" — maxStalledCount exceeded, moved to failed
})

taskora.on("task:stalled", ({ task, id, count, action }) => {
  metrics.increment("jobs.stalled", { task, action })
})
```

## Preventing Stalls

For long-running jobs, call `ctx.heartbeat()` to extend the lock and prevent stall detection:

```ts
taskora.task("long-export", {
  stall: { interval: 30_000 },
  handler: async (data, ctx) => {
    for (const batch of batches) {
      await processBatch(batch)
      ctx.heartbeat() // extend lock, prevent stall detection
    }
  },
})
```

## Cancelled Stalled Jobs

If a job is both stalled **and** has a `cancelledAt` flag (was cancelled while active), the stall check moves it directly to the `cancelled` set instead of recovering it.
