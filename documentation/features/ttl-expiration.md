# TTL & Expiration

Control job lifetimes with TTL, singleton mode, and per-key concurrency limits.

## TTL (Time-to-Live)

Set a maximum lifetime for jobs. If a job isn't processed before its TTL expires, it's moved to the `expired` state.

### Task-Level TTL

```ts
taskora.task("time-sensitive", {
  ttl: {
    max: "1h",          // expire after 1 hour
    onExpire: "fail",    // "fail" (default) or "discard"
  },
  handler: async (data, ctx) => { /* ... */ },
})
```

### Per-Job TTL

Override TTL at dispatch time:

```ts
timeSensitiveTask.dispatch(data, {
  ttl: "30m", // this specific job expires in 30 minutes
})
```

### Expiration Behavior

| `onExpire` | Behavior |
|---|---|
| `"fail"` | Job moves to `expired` state, stores `ExpiredError` |
| `"discard"` | Job is silently removed — no trace in failed/expired sets |

TTL is checked during dequeue (`moveToActive.lua`). Jobs that expire while `waiting` or `delayed` are caught when a worker tries to pick them up.

## Singleton

Ensure only **one job per task** is active at a time.

```ts
taskora.task("global-sync", {
  singleton: true,
  handler: async (data, ctx) => {
    await syncAllData() // only one instance runs at a time
  },
})
```

When a worker tries to dequeue and another job is already active, the dequeue is skipped (the job stays in the waiting queue with a 1s retry marker).

## Concurrency Per Key

Limit concurrent active jobs for a specific key:

```ts
processUserDataTask.dispatch(data, {
  concurrencyKey: `user:${userId}`,
  concurrencyLimit: 2,  // max 2 concurrent jobs for this user
})
```

This uses an atomic counter in Redis (`INCR` on claim, `DECR` on ack/fail/nack/stall). If the limit is reached, the job waits in the queue.

### Use Cases

- Limit API calls per customer
- Prevent multiple concurrent writes to the same resource
- Rate-limit by tenant in a multi-tenant system

```ts
taskora.task("sync-account", {
  concurrencyLimit: 1, // task-level default
  handler: async (data: { accountId: string }, ctx) => {
    await syncAccount(data.accountId)
  },
})

// Per-dispatch override
syncAccountTask.dispatch(data, {
  concurrencyKey: `account:${data.accountId}`,
  concurrencyLimit: 1, // one sync per account at a time
})
```
