# Error Handling

Taskora provides a rich error hierarchy to distinguish between different failure modes. All errors extend `TaskoraError`.

## Error Classes

### `ValidationError`

Thrown when input or output data fails schema validation.

```ts
try {
  await handle.result
} catch (err) {
  if (err instanceof ValidationError) {
    console.log(err.issues) // Standard Schema issues array
  }
}
```

### `RetryError`

Thrown by `ctx.retry()` to trigger a manual retry. Always retries (bypasses `retryOn`/`noRetryOn` filters) unless max attempts are exhausted.

```ts
throw ctx.retry({ delay: 5000, reason: "Rate limited" })
// or
throw new RetryError("Rate limited", { delay: 5000 })
```

### `TimeoutError`

Thrown when a job exceeds its timeout. **Not retried by default** — add to `retryOn` explicitly if you want timeout retries.

```ts
taskora.task("slow-task", {
  timeout: 5000,
  retry: {
    attempts: 3,
    retryOn: [TimeoutError], // opt-in to retry on timeout
  },
  handler: async (data, ctx) => { /* ... */ },
})
```

### `JobFailedError`

Thrown by `handle.result` / `handle.waitFor()` when the job failed permanently.

```ts
try {
  await handle.result
} catch (err) {
  if (err instanceof JobFailedError) {
    console.log(err.message) // original error message
  }
}
```

### `CancelledError`

Thrown when a job is cancelled via `handle.cancel()`.

```ts
try {
  await handle.result
} catch (err) {
  if (err instanceof CancelledError) {
    console.log(err.reason) // optional cancellation reason
  }
}
```

### `ThrottledError`

Thrown when dispatch is rejected by throttle (only with `throwOnReject: true`).

```ts
try {
  sendEmailTask.dispatch(data, {
    throttle: { key: "emails", max: 100, window: "1h" },
    throwOnReject: true,
  })
} catch (err) {
  if (err instanceof ThrottledError) {
    console.log(err.key) // "emails"
  }
}
```

### `DuplicateJobError`

Thrown when dispatch is rejected by deduplication (only with `throwOnReject: true`).

```ts
if (err instanceof DuplicateJobError) {
  console.log(err.key)        // dedup key
  console.log(err.existingId) // ID of the existing job
}
```

### `ExpiredError`

Stored as the error when a job's TTL expires before processing.

### `StalledError`

Stored as the error when a job exceeds `maxStalledCount` and is moved to failed.

### `SchemaVersionMismatchError`

A library-internal safety net for taskora upgrades that you will almost never see — we've built CI snapshot tests, a decoupled bump policy, and rolling-upgrade semantics specifically so this error doesn't fire in practice. If something ever does slip through all of that, `app.start()` / `app.ensureConnected()` throws **before** any worker, scheduler, or dispatch touches Redis, so your data is never in an ambiguous state.

```ts
try {
  await app.start()
} catch (err) {
  if (err instanceof SchemaVersionMismatchError) {
    console.error(err.code)     // "theirs_too_new" | "theirs_too_old" | "invalid_meta"
    console.error(err.ours)     // { wireVersion, minCompat, writtenBy }
    console.error(err.theirs)   // same + writtenAt
    process.exit(1)
  }
  throw err
}
```

This is **not** the same as task payload versioning — it protects taskora's own storage layout against incompatible library upgrades, not your task input schemas. See [Upgrading](../operations/upgrading) for the full story, including what each `code` means and the automated tests that make sure a breaking release can't slip through unnoticed.

## Default Error Logging

When a task handler throws and **no** `failed` listener is registered (neither `task.on("failed")` nor `taskora.on("task:failed")`), taskora logs the error to `console.error` automatically:

```
[taskora] task "send-email" job a1b2c3d4 failed (attempt 1/3, will retry)
Error: Connection refused
    at handler (/app/tasks/email.ts:15:11)
    at Array.handlerMw (/app/node_modules/taskora/src/worker.ts:82:36)
    ...
```

This fires synchronously on the worker that processed the job — no Redis round-trip, full stack trace preserved.

The default logger is **automatically suppressed** the moment you register your own `failed` listener:

```ts
// Default logging stops as soon as you add this:
taskora.on("task:failed", (event) => {
  myLogger.error({ task: event.task, jobId: event.id, error: event.error })
})
```

Per-task listeners also suppress it for that specific task:

```ts
sendEmailTask.on("failed", (event) => { /* custom handling */ })
// Default logger no longer fires for send-email, but still fires for other tasks
```

## Error Flow

| Error | When | Retried? |
|---|---|---|
| `ValidationError` | Schema validation fails | No |
| `RetryError` | `ctx.retry()` called | Always (if attempts remain) |
| `TimeoutError` | Handler exceeds timeout | No (opt-in via `retryOn`) |
| `CancelledError` | `handle.cancel()` called | No |
| `ThrottledError` | Throttle rejects dispatch | N/A (dispatch-time) |
| `DuplicateJobError` | Dedup rejects dispatch | N/A (dispatch-time) |
| `ExpiredError` | TTL expires | No |
| `StalledError` | maxStalledCount exceeded | No |
| Any other `Error` | Handler throws | Yes (if attempts remain) |
