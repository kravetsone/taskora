# Job Context

Every task handler receives a `ctx` object as its second argument. The context provides tools for communication, control flow, and observability during job execution.

```ts
taskora.task("process", async (data: Input, ctx) => {
  // ctx is Taskora.Context
})
```

## Properties

### `ctx.id`

The unique job ID (UUID v4).

### `ctx.attempt`

Current attempt number (starts at 1). Increments on each retry.

### `ctx.timestamp`

Job creation timestamp (milliseconds since epoch).

### `ctx.signal`

An `AbortSignal` that fires when:
- The job is **cancelled** via `handle.cancel()`
- The job **times out**

Use it with any API that accepts AbortSignal:

```ts
taskora.task("fetch-data", {
  timeout: 10_000,
  handler: async (data: { url: string }, ctx) => {
    const res = await fetch(data.url, { signal: ctx.signal })
    return await res.json()
  },
})
```

## Methods

### `ctx.heartbeat()`

Extend the job's lock TTL. Call this in long-running jobs to prevent stall detection from reclaiming them.

```ts
taskora.task("long-job", async (data, ctx) => {
  for (const chunk of chunks) {
    await processChunk(chunk)
    ctx.heartbeat() // "I'm still alive"
  }
})
```

### `ctx.progress(value)`

Report progress as a number or object. Fire-and-forget — does not block the handler.

```ts
taskora.task("upload", async (data, ctx) => {
  ctx.progress(0)
  await step1()
  ctx.progress(33)
  await step2()
  ctx.progress(66)
  await step3()
  ctx.progress(100)
})
```

Progress is stored in Redis and queryable via `handle.getProgress()`.

### `ctx.retry(options?)`

Request a manual retry. Returns a `RetryError` — throw it to trigger the retry.

```ts
taskora.task("flaky-api", async (data, ctx) => {
  const res = await fetch(data.url)

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after")) * 1000
    throw ctx.retry({ delay: retryAfter, reason: "Rate limited" })
  }

  return await res.json()
})
```

`RetryError` **always retries** (bypasses `retryOn`/`noRetryOn` filters) unless max attempts are exhausted.

### `ctx.log`

Structured logging attached to the job. Queryable via `handle.getLogs()`.

```ts
taskora.task("import", async (data, ctx) => {
  ctx.log.info("Starting import", { source: data.source })
  ctx.log.warn("Skipping invalid row", { row: 42, reason: "missing field" })
  ctx.log.error("Failed to parse", { raw: data.raw })
})
```

Each log entry is a `LogEntry`:

```ts
interface LogEntry {
  level: "info" | "warn" | "error"
  message: string
  meta?: Record<string, unknown>
  timestamp: number
}
```
