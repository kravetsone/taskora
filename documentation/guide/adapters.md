# Adapters

Taskora separates the core engine from storage backends via the `Adapter` interface. Your task handlers never import `ioredis` directly — the adapter is the only thing that knows about your database.

## Redis Adapter

The production adapter. Requires Redis 7.0+ and `ioredis` as a peer dependency.

```ts
import { redisAdapter } from "taskora/redis"
```

### Connection Modes

```ts
// URL string
const adapter = redisAdapter("redis://localhost:6379")

// Options object
const adapter = redisAdapter({ host: "redis.internal", port: 6379, password: "secret" })

// Existing ioredis instance
import Redis from "ioredis"
const redis = new Redis("redis://localhost:6379")
const adapter = redisAdapter(redis)
```

### Key Prefix

All Redis keys use the pattern `taskora:{taskName}:{key}`. You can add a custom prefix to namespace multiple apps on the same Redis instance:

```ts
const adapter = redisAdapter("redis://localhost:6379", {
  prefix: "myapp",
})
// Keys become: myapp:taskora:{taskName}:{key}
```

### Redis Cluster

All keys for a single job use a `{hash tag}` for cluster compatibility. Jobs are guaranteed to land on the same shard.

## Memory Adapter

Zero-dependency in-memory adapter. Ideal for development, testing, and single-process use cases.

```ts
import { memoryAdapter } from "taskora/memory"

const app = taskora({
  adapter: memoryAdapter(),
})
```

The memory adapter implements the full `Adapter` interface — including delayed jobs, sorted sets, and concurrency tracking — using plain JavaScript data structures.

::: warning
The memory adapter does not persist data. All jobs are lost when the process exits. Use it for development and testing only.
:::

## Adapter Interface

If you want to build a custom adapter (e.g., PostgreSQL, SQLite), implement the `Taskora.Adapter` interface:

```ts
interface Adapter {
  connect(): Promise<void>
  disconnect(): Promise<void>
  enqueue(task, jobId, data, options): Promise<void>
  dequeue(task, lockTtl, token, options?): Promise<DequeueResult | null>
  blockingDequeue(task, lockTtl, token, timeoutMs, options?): Promise<DequeueResult | null>
  ack(task, jobId, token, result): Promise<void>
  fail(task, jobId, token, error, retry?): Promise<void>
  nack(task, jobId, token): Promise<void>
  extendLock(task, jobId, token, ttl): Promise<"extended" | "lost" | "cancelled">
  cancel(task, jobId, reason?): Promise<"cancelled" | "flagged" | "not_cancellable">
  // ... and more (subscribe, inspect, schedule, etc.)
}
```

The full interface has ~40 methods covering enqueue, dequeue, acknowledge, inspect, schedule, and dead letter queue operations. See `src/types.ts` for the complete definition.
