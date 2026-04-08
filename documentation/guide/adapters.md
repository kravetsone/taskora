# Adapters

Taskora separates the core engine from storage backends via the `Adapter` interface. Your task handlers never import `ioredis` directly — the adapter is the only thing that knows about your database.

## Redis Adapter

The production adapter. Requires Redis 7.0+. You can pick one of two drivers depending on your runtime — both implement the same `Adapter` interface and share 100% of taskora's logic (Lua scripts, key layout, state machines).

| Entry | Runtime | Peer dep | Use when |
|---|---|---|---|
| `taskora/redis` | Any | `ioredis` | The default. Re-exports `taskora/redis/ioredis`. |
| `taskora/redis/ioredis` | Any (Node, Bun, Deno) | `ioredis` | Explicit ioredis. Required for Redis Cluster or Sentinel. |
| `taskora/redis/bun` | **Bun only** | none | Bun deployments that want to skip the ioredis peer dep. |

### ioredis driver (default)

```ts
import { redisAdapter } from "taskora/redis"
// or, equivalently:
import { redisAdapter } from "taskora/redis/ioredis"

// URL string
const adapter = redisAdapter("redis://localhost:6379")

// Options object
const adapter = redisAdapter({ host: "redis.internal", port: 6379, password: "secret" })

// Existing ioredis instance — adapter will NOT close it on disconnect
import Redis from "ioredis"
const redis = new Redis("redis://localhost:6379")
const adapter = redisAdapter(redis)
```

### Bun driver

```ts
import { redisAdapter } from "taskora/redis/bun"

// URL string
const adapter = redisAdapter("redis://localhost:6379")

// Options
const adapter = redisAdapter({ host: "localhost", port: 6379 })

// Existing Bun.RedisClient — adapter will NOT close it on disconnect
const client = new Bun.RedisClient("redis://localhost:6379")
const adapter = redisAdapter(client)
```

The Bun driver routes commands through `Bun.RedisClient.send()` (the generic RESP escape hatch). Bun's auto-pipelining batches same-tick calls into a single round trip, so pipeline performance matches ioredis. The driver issues `HELLO 2` at connect time to force RESP2 response shapes — this keeps `HGETALL`, Lua return values, and stream entries identical across drivers.

::: warning Bun driver limitations
- **No Redis Cluster.** `Bun.RedisClient` does not support cluster mode. Cluster users must stay on the ioredis driver.
- **No Redis Sentinel.** Same constraint.
- **Bun runtime only.** The Bun driver throws a clear error if loaded under Node.
:::

### Key Prefix

All Redis keys use the pattern `taskora:{taskName}:{key}`. You can add a custom prefix to namespace multiple apps on the same Redis instance:

```ts
const adapter = redisAdapter("redis://localhost:6379", {
  prefix: "myapp",
})
// Keys become: myapp:taskora:{taskName}:{key}
```

### Redis Cluster

All keys for a single job use a `{hash tag}` for cluster compatibility. Jobs are guaranteed to land on the same shard. Cluster routing requires the **ioredis driver** — Bun's built-in client does not support cluster mode.

## Memory Adapter

Zero-dependency in-memory adapter. Ideal for development, testing, and single-process use cases.

```ts
import { memoryAdapter } from "taskora/memory"

const taskora = createTaskora({
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
