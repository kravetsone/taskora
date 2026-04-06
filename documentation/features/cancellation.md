# Cancellation

Taskora supports graceful job cancellation with instant notification via Redis pub/sub.

## Cancelling a Job

```ts
const handle = longTask.dispatch(data)

// Later...
await handle.cancel({ reason: "User requested cancellation" })
```

## How It Works

Cancellation depends on the job's current state:

| State | Behavior |
|---|---|
| `waiting` / `delayed` / `retrying` | Moved to `cancelled` immediately (atomic Lua) |
| `active` | Sets `cancelledAt` flag + PUBLISH to cancel channel. Worker picks it up. |
| `completed` / `failed` | Not cancellable (`"not_cancellable"`) |

### Instant Cancel for Active Jobs

Active jobs are cancelled via Redis pub/sub — no polling delay:

1. `cancel.lua` sets a `cancelledAt` flag on the job hash and PUBLISHes the job ID
2. The worker subscribes to the cancel channel on startup
3. When the message arrives, `controller.abort("cancelled")` fires immediately
4. `ctx.signal` is aborted — any `fetch()`, `setTimeout`, or signal-aware operation stops

Fallback: if the pub/sub message is missed, `extendLock()` detects the flag and returns `"cancelled"`.

## Handling Cancellation in Tasks

### Using `ctx.signal`

The simplest approach — pass the signal to APIs that support it:

```ts
app.task("download-file", async (data: { url: string }, ctx) => {
  const res = await fetch(data.url, { signal: ctx.signal })
  return await res.arrayBuffer()
})
```

### Using `onCancel` Hook

For custom cleanup logic, define an `onCancel` hook:

```ts
app.task("transcode-video", {
  onCancel: async (data, ctx) => {
    // Clean up temporary files
    await fs.unlink(`/tmp/${ctx.id}.mp4`)
    ctx.log.info("Cleaned up temporary files")
  },
  handler: async (data: { videoUrl: string }, ctx) => {
    const tmpPath = `/tmp/${ctx.id}.mp4`
    await downloadVideo(data.videoUrl, tmpPath, { signal: ctx.signal })
    return await transcode(tmpPath)
  },
})
```

The `onCancel` hook runs **after** the handler is aborted but **before** the job is finalized. The context's signal is already aborted at this point.

## Cancelled State

`"cancelled"` is a distinct terminal state — separate from `"failed"`:

```ts
try {
  await handle.result
} catch (err) {
  if (err instanceof CancelledError) {
    console.log(err.reason) // "User requested cancellation"
  }
}
```

## Events

```ts
// Per-task
task.on("cancelled", ({ id, reason }) => {
  console.log(`Job ${id} cancelled: ${reason}`)
})

// App-wide
app.on("task:cancelled", ({ id, task, reason }) => {
  console.log(`${task}:${id} cancelled`)
})
```
