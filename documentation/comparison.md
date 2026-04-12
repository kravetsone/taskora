---
description: How Taskora compares to BullMQ, Agenda, and pg-boss — feature-by-feature breakdown for Node.js task queues.
---

# Comparison

Choosing a task queue for Node.js? Here's an honest feature comparison.

## Feature Matrix

| Feature | Taskora | BullMQ | Agenda | pg-boss |
|---|:---:|:---:|:---:|:---:|
| **TypeScript-native** | Full | Full | Full (v6+) | Full |
| **Schema validation** | Standard Schema | — | — | — |
| **Middleware** | Koa-style onion model | Event hooks | — | — |
| **Task contracts** | defineTask / staticContract | — | — | — |
| **Job versioning & migrations** | Full migration chains | — | — | — |
| **In-memory test adapter** | Built-in | — | — | — |
| **Virtual time testing** | Built-in | — | — | — |
| **Debounce** | Built-in | Built-in | — | — |
| **Throttle** | Built-in | Pattern-based | — | Singleton slots |
| **Deduplication** | Built-in | Built-in | — | Singleton keys |
| **Batch collect** | Built-in | Pro (paid) | — | batchSize |
| **TTL / expiration** | Built-in | — | — | Built-in |
| **Singleton mode** | Built-in | — | — | singletonKey |
| **Concurrency per key** | Built-in | Pro (Groups) | — | — |
| **Cancellation** | Instant (pub/sub) | AbortSignal | — | Built-in |
| **Cron / scheduling** | Built-in + leader election | Built-in | Built-in | Built-in |
| **Workflows** | chain, group, chord | FlowProducer (tree) | — | — |
| **Admin dashboard** | @taskora/board | Bull Board / Taskforce | Agendash | Community |
| **Inspector / DLQ** | Built-in | QueueEvents + dashboard | Agendash | Built-in |
| **Retry + backoff** | 4 strategies + selective | Built-in | Exponential | retryLimit/delay |
| **Events** | Redis Streams (fan-out) | QueueEvents | — | Pub/sub |
| **Backend** | Redis, Memory | Redis | MongoDB | PostgreSQL |

## Developer Experience

Beyond the feature checklist, day-to-day DX is where Taskora pulls ahead.

### Typed from dispatch to result

```ts
const handle = sendEmailTask.dispatch({ to: "a@b.com", body: "hi" });
//    ^? ResultHandle<{ messageId: string }>

const { messageId } = await handle.result;
//      ^? string — inferred end-to-end
```

`dispatch()` is synchronous — it returns a typed `ResultHandle` immediately. `await handle` confirms enqueue, `handle.result` resolves to the typed output. In BullMQ you need a separate `QueueEvents` instance and `job.waitUntilFinished(queueEvents)` with no output typing.

### Manual retry from the handler

```ts
handler: async (data, ctx) => {
  const res = await fetch(data.url);
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after")) * 1000;
    throw ctx.retry({ delay: retryAfter, reason: "rate-limited" });
  }
  return res.json();
}
```

`ctx.retry()` lets you control exactly when the next attempt fires — useful for respecting upstream `Retry-After` headers. In BullMQ you throw an error and hope the static backoff config aligns.

### Test without infrastructure

```ts
const runner = createTestRunner({ from: app }); // patches prod app to memory

const { result, state, logs } = await runner.execute(sendEmailTask, {
  to: "a@b.com", body: "hi"
});

expect(state).toBe("completed");
expect(result.messageId).toBeDefined();
```

`createTestRunner({ from: app })` takes your production app with all its tasks, middleware, and migrations — patches every task to use an in-memory backend. No Docker, no Redis, no mocks. Virtual time lets you test delayed jobs and retry backoff without `setTimeout`.

### Zero-config ioredis

BullMQ requires `maxRetriesPerRequest: null` and `enableReadyCheck: false` — without them, a reconnect kills the worker loop. Taskora's blocking commands run inside internal retry loops, so ioredis defaults just work. One less footgun on day one.

### One object, all capabilities

BullMQ splits every concern into a separate class — `Queue` for dispatch, `Worker` for processing, `QueueEvents` for listening, `FlowProducer` for flows. You wire them together by name strings, and types don't flow between them.

Taskora puts everything on the task:

```ts
const sendEmailTask = taskora.task("send-email", {
  schema: { in: EmailInput, out: EmailOutput },
  retry: { attempts: 3, backoff: "exponential" },
  timeout: "30s",
  concurrency: 10,
  schedule: { cron: "0 9 * * MON" },
  middleware: [withSentry],
  handler: async (data, ctx) => {
    ctx.log.info("sending", { to: data.to });
    const id = await mailer.send(data);
    return { messageId: id };
  },
});

// dispatch, events, workflows, inspect — all from the same object
sendEmailTask.dispatch({ to: "a@b.com", body: "hi" });
sendEmailTask.on("completed", ({ result }) => { /* typed */ });
sendEmailTask.s({ to: "a@b.com", body: "hi" }).pipe(logTask.s());
```

Schema, retry, timeout, concurrency, schedule, middleware, handler — one definition, one place to look. No name-string wiring, no scattered config across multiple class instances.

### Everything composes with types

Contracts, workflows, middleware, events — types flow through every layer:

```ts
// contract — no handler import needed on the producer
const resizeContract = defineTask({
  name: "resize-image",
  schema: { in: ImageInput, out: ImageOutput },
});

// workflow — output types chain automatically
const pipeline = chain(
  downloadTask.s({ url }),       // → Buffer
  resizeTask.s(),                // Buffer → ImageOutput
  uploadTask.s(),                // ImageOutput → { cdn: string }
);

const { cdn } = await pipeline.dispatch().result;
//      ^? string
```

No `as unknown as` casts, no manual generics, no separate type packages. Define the schema once — types propagate from dispatch through middleware, handler, events, workflows, contracts, and result handles.

## Key Differences

### vs BullMQ

BullMQ is the most established Redis-based queue. Taskora differs in:

- **Workflows** — BullMQ has FlowProducer for parent-child tree structures. Taskora has full DAG composition: [chain](./features/workflows.md) (sequential pipeline), [group](./features/workflows.md#group) (parallel fan-out), [chord](./features/workflows.md#chord) (fan-in merge), plus `.map()` / `.chunk()` sugar — all type-safe end-to-end. `WorkflowHandle` gives you `.result`, `.cancel()`, `.getState()`.
- **Task contracts** — Taskora has [`defineTask()`](./guide/contracts.md) and `staticContract()` for producer/consumer split. Define a contract once, `register()` on the producer side, `implement()` on the worker. Types flow through, no handler import needed on the producer. BullMQ leaves this to userland.
- **Middleware** — BullMQ uses event hooks for cross-cutting concerns. Taskora has a composable [Koa-style middleware](./features/middleware.md) pipeline where you can transform `ctx.data` before the handler and inspect `ctx.result` after.
- **Schema validation** — Taskora validates input/output with any [Standard Schema](./guide/tasks.md#with-schema-validation) library (Zod, Valibot, ArkType) — on both dispatch and worker side. BullMQ leaves this to userland.
- **Versioning** — BullMQ has no built-in migration story. Taskora has full [migration chains](./features/versioning.md): bump version, add a migration function, deploy — old jobs in the queue are migrated automatically before the handler runs.
- **Testing** — BullMQ requires Redis (or redis-memory-server / ioredis-mock). Taskora ships [`taskora/test`](./testing/index.md) with an in-memory adapter and virtual time — no Docker, no mocks.
- **Batch collect** — Accumulating items into batches is a Pro (paid) feature in BullMQ. It's [built into Taskora](./features/batch-processing.md) with three flush triggers (debounce, maxSize, maxWait).
- **TTL / singleton** — Taskora has first-class [TTL with fail/discard policies](./features/ttl-expiration.md), singleton mode (one active job per task), and concurrency-per-key. BullMQ has worker-level timeout but no dispatch-time TTL; group-based concurrency is Pro only.
- **Cancellation** — Both support cancellation, but Taskora uses Redis pub/sub for [instant cancel delivery](./features/cancellation.md) to the worker mid-execution — no polling. Active jobs get `ctx.signal` aborted immediately, plus an `onCancel` cleanup hook.
- **Dashboard** — BullMQ has the open-source Bull Board and paid Taskforce.sh. Taskora ships [`@taskora/board`](./operations/board.md) — a built-in admin dashboard with workflow DAG visualization, throughput charts, DLQ management, job timeline, and real-time SSE updates.

### vs Agenda

Agenda is a MongoDB-based scheduler, strong for cron-style recurring jobs:

- **Database** — Agenda is MongoDB-only. Taskora uses Redis (with PostgreSQL planned).
- **Focus** — Agenda is primarily a job scheduler. Taskora is a full task queue with scheduling as one feature among many — workflows, batch collect, middleware, contracts, versioning, and more.
- **Type safety** — Agenda v6 is TypeScript-native, but doesn't offer typed dispatch-to-result flows. Taskora's `ResultHandle` gives you typed `.result`, and task contracts carry input/output types across service boundaries.
- **Dashboard** — Agenda has Agendash. Taskora has `@taskora/board` with real-time SSE, workflow DAG visualization, and DLQ management.
- **Testing** — Agenda requires a MongoDB instance. Taskora tests run in pure memory with virtual time.

### vs pg-boss

pg-boss runs on PostgreSQL — useful if you don't want to add Redis:

- **Database** — pg-boss leverages PostgreSQL for queueing (SKIP LOCKED). Taskora uses Redis for performance-critical dequeue (BZPOPMIN, Lua scripts).
- **Throttle/dedup** — pg-boss has singleton-based throttling and deduplication. Taskora offers separate [debounce, throttle, and dedup](./features/flow-control.md) primitives with configurable keys and windows.
- **Workflows** — pg-boss has no built-in workflow composition. Taskora has type-safe chain, group, and chord with DAG execution.
- **Testing** — pg-boss requires a PostgreSQL instance. Taskora tests run in pure memory.
- **Dashboard** — Both have admin dashboards. Taskora's `@taskora/board` includes workflow DAG visualization and real-time SSE.

## Migration from BullMQ

| BullMQ | Taskora |
|---|---|
| `new Queue(name)` + `new Worker(name, fn)` | `createTaskora({ adapter })` + `taskora.task(name, fn)` |
| `queue.add(name, data)` | `task.dispatch(data)` |
| `job.waitUntilFinished(events)` | `await handle.result` |
| `worker.on("completed", fn)` | `task.on("completed", fn)` |
| `worker.concurrency` option | `taskora.task(name, { concurrency })` |
| `job.progress(value)` | `ctx.progress(value)` |
| `job.log(msg)` | `ctx.log.info(msg)` |
| `new FlowProducer().add(tree)` | `chain(a.s(data), b.s()).dispatch()` |
| `QueueScheduler` | Built-in, automatic |
| Separate producer / worker files | `defineTask()` + `register()` / `implement()` |

### Steps

1. Create an instance with `createTaskora({ adapter: redisAdapter(...) })`
2. Define tasks with `taskora.task(name, { handler, ... })`
3. Replace `queue.add()` with `task.dispatch(data)`
4. Replace event listeners with `task.on()` or `taskora.on()`
5. Replace result polling with `await handle.result`
6. Move retry, concurrency, timeout config into task options
7. Add `await taskora.start()` / `await taskora.close()`
8. Write tests using `createTestRunner()` — no Redis needed
9. Replace `FlowProducer` trees with `chain()` / `group()` / `chord()`
10. If splitting services — replace shared Queue instances with [task contracts](./guide/contracts.md)

### ioredis connection config

BullMQ requires `maxRetriesPerRequest: null` and `enableReadyCheck: false` on the ioredis client — without them, a long reconnect can surface an uncaught `MaxRetriesPerRequestError` that kills the worker loop. **You can drop both options when moving to Taskora.** Taskora's blocking commands (`BZPOPMIN`, `XREAD BLOCK`) run inside retry loops in the worker, event reader, and job waiter, so a transient ioredis error is swallowed and retried on the next tick. ioredis defaults are safe. See [Adapters → ioredis driver](./guide/adapters.md#ioredis-driver-default) for the full explanation.
