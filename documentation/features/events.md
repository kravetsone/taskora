# Events

Taskora provides a typed event system for real-time job monitoring. Events are emitted at both the task and app levels.

## Task Events

```ts
const sendEmailTask = taskora.task("send-email", {
  handler: async (data, ctx) => { /* ... */ },
})

sendEmailTask.on("completed", ({ id, result, duration, attempt }) => {
  console.log(`Email sent in ${duration}ms (attempt ${attempt})`)
})

sendEmailTask.on("failed", ({ id, error, attempt, willRetry }) => {
  if (!willRetry) {
    alertOncall(`Email ${id} permanently failed: ${error}`)
  }
})

sendEmailTask.on("retrying", ({ id, attempt, nextAttempt, error }) => {
  console.log(`Retrying ${id}: attempt ${attempt} → ${nextAttempt}`)
})

sendEmailTask.on("progress", ({ id, progress }) => {
  console.log(`Job ${id} progress: ${JSON.stringify(progress)}`)
})

sendEmailTask.on("active", ({ id, attempt }) => {
  console.log(`Job ${id} started processing (attempt ${attempt})`)
})

sendEmailTask.on("stalled", ({ id, count, action }) => {
  console.log(`Job ${id} stalled (${action}: count ${count})`)
})

sendEmailTask.on("cancelled", ({ id, reason }) => {
  console.log(`Job ${id} cancelled: ${reason}`)
})
```

## App Events

App events include the task name in the payload, useful for cross-cutting monitoring.

```ts
taskora.on("task:completed", ({ task, id, result, duration, attempt }) => {
  metrics.increment("jobs.completed", { task })
  metrics.histogram("jobs.duration", duration, { task })
})

taskora.on("task:failed", ({ task, id, error, attempt, willRetry }) => {
  if (!willRetry) {
    metrics.increment("jobs.failed", { task })
  }
})

taskora.on("task:active", ({ task, id, attempt }) => {
  metrics.increment("jobs.active", { task })
})

taskora.on("task:stalled", ({ task, id, count, action }) => {
  metrics.increment("jobs.stalled", { task, action })
})

taskora.on("task:cancelled", ({ task, id, reason }) => {
  metrics.increment("jobs.cancelled", { task })
})
```

### Worker Events

```ts
taskora.on("worker:ready", () => {
  console.log("Workers started, processing jobs")
})

taskora.on("worker:error", (error) => {
  console.error("Worker error:", error)
})

taskora.on("worker:closing", () => {
  console.log("Workers shutting down...")
})
```

## Event Payload Types

| Event | Payload |
|---|---|
| `completed` | `{ id, result, duration, attempt }` |
| `failed` | `{ id, error, attempt, willRetry }` |
| `retrying` | `{ id, attempt, nextAttempt, error }` |
| `progress` | `{ id, progress }` |
| `active` | `{ id, attempt }` |
| `stalled` | `{ id, count, action: "recovered" \| "failed" }` |
| `cancelled` | `{ id, reason? }` |

App events add `{ task: string }` to each payload.

## Default Error Logging

If no `failed` listener is registered, taskora logs errors to `console.error` automatically with full stack traces:

```
[taskora] task "send-email" job a1b2c3d4 failed (attempt 1/3, will retry)
Error: Connection refused
    at handler (/app/tasks/email.ts:15:11)
    ...
```

This prevents errors from being silently swallowed. The default logger is suppressed as soon as you register any `failed` listener — either per-task or app-level. See [Error Handling](/guide/error-handling#default-error-logging) for details.

## Multi-Instance Behavior

Events use Redis Streams with `XREAD` (not `XREADGROUP`). In a multi-pod deployment:

- **Job processing**: only one pod claims each job (atomic `RPOP` in Lua)
- **Events**: all pods receive all events (fan-out)

If 3 pods subscribe to `task.on("completed")`, all 3 will fire the handler for each completed job. This is by design — events are notifications, not work items. If you need exactly-once event processing, use the job queue itself (dispatch a new task from the event handler with deduplication).

## Implementation

Events are backed by **Redis Streams** (`XADD`). Each state transition in the Lua scripts writes a stream event. The `EventReader` uses `XREAD BLOCK` on a separate connection to consume events in real-time.

Stream positions are snapshotted via `XREVRANGE` before workers start — this prevents missing events during the startup window.
