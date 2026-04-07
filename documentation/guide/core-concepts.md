# Core Concepts

Understanding the building blocks of taskora.

<JobLifecycleVisualizer />

## Architecture

```
┌────────────────────────────────────────┐
│  App                                   │
│  ┌──────┐ ┌──────┐ ┌──────┐          │
│  │Task A│ │Task B│ │Task C│  ...      │
│  └──┬───┘ └──┬───┘ └──┬───┘          │
│     │        │        │               │
│     └────────┴────────┘               │
│              │                        │
│        ┌─────┴─────┐                  │
│        │  Adapter   │  ← abstraction  │
│        └─────┬─────┘                  │
│              │                        │
│     ┌────────┴────────┐               │
│     │  Redis / Memory │               │
│     └─────────────────┘               │
└────────────────────────────────────────┘
```

### App

The taskora instance is the central registry. It holds your adapter, serializer, tasks, middleware, schedules, and configuration defaults. You create one per process.

### Task

A `Task` is a named handler with configuration. It defines what happens when a job is processed — plus retry logic, timeout, concurrency, middleware, and more.

### Worker

When you call `taskora.start()`, a `Worker` is created for each registered task. Workers use blocking dequeue (BZPOPMIN) to efficiently pull jobs from their task's queue — no polling.

### Adapter

The `Adapter` is the storage abstraction layer. The core `taskora` package never imports `ioredis` or `pg` directly. This means:

- You only install the driver you need
- Swapping backends requires zero handler changes
- Testing uses the in-memory adapter — no Docker needed

## Job States

A job moves through a well-defined state machine:

| State | Description |
|---|---|
| `waiting` | Queued, ready to be picked up by a worker |
| `delayed` | Scheduled for future processing (delay or retry backoff) |
| `active` | Currently being processed by a worker |
| `completed` | Handler returned successfully |
| `failed` | Handler threw and all retries exhausted |
| `retrying` | Handler threw but will be retried (moves to `delayed`) |
| `cancelled` | Explicitly cancelled via `handle.cancel()` |
| `expired` | TTL exceeded before processing started |

### State Transitions

```
dispatch() ──→ waiting ──→ active ──→ completed
                  │           │
           (delay option)     ├──→ failed
                  │           │
                  ▼           ├──→ retrying ──→ delayed ──→ waiting
               delayed        │
                              ├──→ cancelled
                              │
                              └──→ expired
```

## Connection Lifecycle

```ts
const taskora = createTaskora({ adapter: redisAdapter("redis://localhost:6379") })

// Adapter connects lazily on first dispatch
sendEmailTask.dispatch({ to: "user@example.com", subject: "Hi" })

// Or start workers (connects + starts processing)
await taskora.start()

// Graceful shutdown — finishes active jobs, disconnects
await taskora.close()
```

<WorkerConcurrencyVisualizer />
