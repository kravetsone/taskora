# Dispatching Jobs

Every task has a `dispatch()` method that enqueues a job and returns a `ResultHandle` synchronously.

## Basic Dispatch

```ts
const handle = sendEmail.dispatch({
  to: "user@example.com",
  subject: "Welcome!",
})
```

`dispatch()` returns immediately — it does **not** wait for the job to be enqueued. The handle is a thenable that resolves to the job ID once enqueued.

## ResultHandle

The `ResultHandle<TOutput>` is the primary way to interact with a dispatched job.

```ts
const handle = sendEmail.dispatch(data)

// Get the job ID (thenable — resolves when enqueued)
const jobId = await handle // UUID string

// Wait for the result (push-based via Redis Streams)
const result = await handle.result // typed as TOutput

// Wait with a timeout
const result = await handle.waitFor(5000) // throws TimeoutError after 5s

// Query current state
const state = await handle.getState() // "waiting" | "active" | "completed" | ...

// Query progress
const progress = await handle.getProgress() // number | object | null

// Get structured logs
const logs = await handle.getLogs() // LogEntry[]

// Cancel the job
await handle.cancel({ reason: "User requested cancellation" })
```

### How Result Waiting Works

`handle.result` and `handle.waitFor()` use **push-based** delivery via a shared Redis Streams XREAD connection (`JobWaiter`). Multiple handles share one connection — no per-job polling.

## Dispatch Options

```ts
sendEmail.dispatch(data, {
  delay: 5000,              // delay processing by 5 seconds
  priority: 10,             // higher priority = processed first
  ttl: "1h",                // expire if not processed within 1 hour
  concurrencyKey: "user:42", // limit concurrency per key
  concurrencyLimit: 2,       // max 2 concurrent jobs for this key
})
```

## Flow Control Options

### Debounce

Replace the previous pending job for the same key. Only the last dispatch within the delay window is processed.

```ts
searchIndex.dispatch(data, {
  debounce: { key: `index:${docId}`, delay: "2s" },
})
```

### Throttle

Rate-limit dispatches per key. Excess dispatches are rejected.

```ts
const handle = apiCall.dispatch(data, {
  throttle: { key: "external-api", max: 10, window: "1m" },
})

console.log(handle.enqueued) // true | false
```

### Deduplicate

Skip dispatch if a job with the same key already exists in a matching state.

```ts
const handle = generateReport.dispatch(data, {
  deduplicate: { key: `report:${userId}`, while: ["waiting", "active"] },
})

if (!handle.enqueued) {
  console.log("Already running:", handle.existingId)
}
```

### Throwing on Rejection

By default, throttle and dedup silently reject (set `handle.enqueued = false`). To throw instead:

```ts
sendEmail.dispatch(data, {
  throttle: { key: "emails", max: 100, window: "1h" },
  throwOnReject: true, // throws ThrottledError or DuplicateJobError
})
```

## Bulk Dispatch

```ts
const handles = sendEmail.dispatchMany([
  { data: { to: "alice@example.com", subject: "Hi" } },
  { data: { to: "bob@example.com", subject: "Hello" }, options: { delay: 5000 } },
])
```
