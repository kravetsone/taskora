# Inspector

The Inspector provides read-only access to queue state — query jobs, check stats, and inspect version distribution.

## Getting the Inspector

```ts
const inspector = app.inspect()
```

## Listing Jobs by State

```ts
const waiting = await inspector.waiting({ task: "send-email", limit: 20, offset: 0 })
const active = await inspector.active()
const delayed = await inspector.delayed({ limit: 50 })
const completed = await inspector.completed({ task: "send-email" })
const failed = await inspector.failed()
const expired = await inspector.expired()
const cancelled = await inspector.cancelled()
```

Each returns an array of `JobInfo` objects.

## Finding a Specific Job

```ts
// Cross-task search (checks all registered tasks)
const job = await inspector.find("550e8400-e29b-41d4-a716-446655440000")

// Typed search (pass a Task object for typed data/result)
const job = await inspector.find(sendEmail, "550e8400...")
// job.data is typed as { to: string, subject: string }
// job.result is typed as the handler's return type
```

## Queue Stats

```ts
const stats = await inspector.stats()
// { waiting: 42, active: 5, delayed: 12, completed: 1500, failed: 3, expired: 0, cancelled: 1 }

// Per-task stats
const emailStats = await inspector.stats({ task: "send-email" })
```

## JobInfo Type

```ts
interface JobInfo<TData, TResult> {
  id: string
  task: string
  state: JobState
  data: TData
  result?: TResult
  error?: string
  progress?: number | Record<string, unknown>
  logs: LogEntry[]
  attempt: number
  version: number
  timestamp: number
  processedOn?: number
  finishedOn?: number
  timeline: Array<{ state: string; at: number }>
}
```

The `timeline` is reconstructed from `timestamp`, `processedOn`, and `finishedOn` fields.

## Version Distribution

Check what job versions are in your queues:

```ts
const status = await inspector.migrations("send-email")
// {
//   version: 3, since: 1, migrations: 2,
//   queue: { oldest: 2, byVersion: { 2: 5, 3: 142 } },
//   delayed: { oldest: 3, byVersion: { 3: 8 } },
//   canBumpSince: 2
// }
```

See [Versioning & Migrations](/features/versioning) for details.
