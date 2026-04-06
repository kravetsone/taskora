# Dead Letter Queue & Retention

Taskora automatically trims both completed and failed jobs to prevent unbounded memory growth. Zero config needed — safe defaults are always on.

## Defaults

| | `maxAge` | `maxItems` |
|---|---|---|
| **completed** | `"1h"` | `100` |
| **failed** | `"7d"` | `300` |

Override if needed:

```ts
const app = taskora({
  adapter: redisAdapter("redis://localhost:6379"),
  retention: {
    completed: { maxAge: "24h", maxItems: 1_000 },
    failed: { maxAge: "30d", maxItems: 5_000 },
  },
})
```

Trim runs piggyback on the stall check interval — no extra timers. It removes the job hash, `:data`, `:result`, `:lock`, and `:logs` keys in batches of 100.

## Accessing the DLQ

```ts
const dlq = app.deadLetters
```

The DLQ operates as a view over the existing `:failed` sorted set — no separate storage.

## Listing Failed Jobs

```ts
const jobs = await dlq.list()
const emailJobs = await dlq.list({ task: "send-email", limit: 50, offset: 0 })
```

## Retrying Jobs

### Single Job

```ts
// Retry by job ID (cross-task search)
await dlq.retry(jobId)

// Retry with typed task reference
await dlq.retry(sendEmail, jobId)
```

The job is atomically removed from the failed set, reset to `waiting`, and re-queued.

### Retry All

```ts
// Retry all failed jobs
await dlq.retryAll()

// Retry all failed jobs for a specific task
await dlq.retryAll({ task: "send-email" })
```

Batched internally (100 per Lua call) for safety.

## Workflow Example

```ts
// 1. Check for accumulated failures
const stats = await app.inspect().stats()
console.log(`Failed jobs: ${stats.failed}`)

// 2. List recent failures
const failures = await app.deadLetters.list({ limit: 10 })
for (const job of failures) {
  console.log(`${job.id}: ${job.error} (attempt ${job.attempt})`)
}

// 3. Fix the underlying issue, then retry all
await app.deadLetters.retryAll()
```
