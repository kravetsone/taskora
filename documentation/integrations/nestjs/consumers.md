# Consumers

A consumer is a Nest provider class that handles jobs for a specific task contract. You write it the same way you'd write any `@Injectable()` service, with full constructor DI — the only addition is the `@TaskConsumer(contract)` decorator and a `process(data, ctx)` method.

## Basic consumer

```ts
import { TaskConsumer } from "@taskora/nestjs"
import type { InferInput, InferOutput, Taskora } from "taskora"
import { MailerService } from "./mailer.service"
import { sendEmailTask } from "@/tasks"

@TaskConsumer(sendEmailTask)
export class SendEmailConsumer {
  constructor(private readonly mailer: MailerService) {}

  async process(
    data: InferInput<typeof sendEmailTask>,
    ctx: Taskora.Context,
  ): Promise<InferOutput<typeof sendEmailTask>> {
    ctx.log.info("sending", { to: data.to })
    return this.mailer.send(data)
  }
}
```

Register it as a normal Nest provider:

```ts
@Module({
  providers: [SendEmailConsumer, MailerService],
})
export class EmailModule {}
```

That's everything. On `onApplicationBootstrap`, the `TaskoraExplorer` walks the DI graph, finds this class, calls `app.implement(sendEmailTask, (data, ctx) => instance.process(data, ctx))`, and then starts the app. Injected dependencies (`MailerService` here) stay live across every job run — you get one consumer instance for the lifetime of the process, exactly like every other `@Injectable()`.

### Why `InferInput<typeof contract>` and not a hand-written type?

`defineTask` stores the input/output schema on the contract value. `InferInput<typeof sendEmailTask>` reads the type directly off that value, so renaming or reshaping the schema updates the consumer's signature automatically. You could write `data: { to: string; subject: string }` by hand, but it drifts — one day someone adds `cc?: string[]` to the schema and the consumer quietly ignores it.

## `@TaskConsumer` options

```ts
@TaskConsumer(sendEmailTask, {
  concurrency: 10,              // parallel in-flight jobs for this task
  timeout: "30s",               // aborts the handler + fails the job
  retry: {
    attempts: 5,
    backoff: "exponential",
    delay: 1000,
    maxDelay: 60_000,
  },
  singleton: false,             // "only one in-flight at a time globally"
  concurrencyLimit: undefined,  // key-based rate limit — see dispatch options
  ttl: { max: "10m", onExpire: "fail" },
  stall: { interval: 30_000, maxCount: 1 },
  version: 2,                   // payload version for schema migrations
  since: 1,                     // oldest supported version
  app: "secondary",             // multi-app routing — see below
})
```

These are the same fields `app.implement(contract, handler, options)` accepts in bare taskora, minus the worker-side-only `handler`, `onCancel`, `middleware`, and `migrate` fields (which arrive via different DI mechanisms — see the sections below).

## Multi-app routing

`@TaskConsumer(contract, { app: 'secondary' })` binds the consumer to a specific named app registered via `TaskoraModule.forRoot({ name: 'secondary' })`. The explorer filters consumers by the `app` option, so each named app only picks up its own consumers.

```ts
@TaskConsumer(sendEmailTask)                        // → default app
class DefaultEmailConsumer {}

@TaskConsumer(sendEmailTask, { app: "secondary" })  // → "secondary" app
class SecondaryEmailConsumer {}
```

Both consumers handle `sendEmailTask`, but they run in isolated apps with independent Redis connections. A dispatch via `TaskoraRef.for(sendEmailTask)` reaches the default consumer; a dispatch via `@InjectTaskoraRef('secondary')` → `.for(sendEmailTask)` reaches the secondary.

See [Deployment > Multi-app](./deployment#multi-app) for the full pattern.

## Using `ctx` inside `process()`

The second argument to `process()` is taskora's `Context` — a per-job handle with progress, logs, retry helpers, and cancellation:

```ts
async process(data: InferInput<typeof processImageTask>, ctx: Taskora.Context) {
  ctx.log.info("starting", { url: data.url })
  await ctx.progress({ phase: "downloading" })

  const buffer = await fetch(data.url).then((r) => r.arrayBuffer())
  await ctx.progress({ phase: "transforming", percent: 30 })

  if (ctx.signal.aborted) throw ctx.signal.reason // fail fast on cancel
  const result = await this.pipeline.transform(buffer, ctx.signal)

  await ctx.progress({ phase: "uploading", percent: 90 })
  const url = await this.storage.upload(result)

  ctx.log.info("done", { url })
  return { url, width: result.width, height: result.height }
}
```

Key fields:

- **`ctx.log.info/warn/error`** — structured logs stored against the job, visible in the inspector and the board.
- **`ctx.progress(value)`** — number or object, surfaced in the board and via `inspector.find()`.
- **`ctx.signal`** — `AbortSignal` that fires on cancellation / timeout / stall recovery. Pass it to `fetch`, child processes, or manual `await` loops so handlers exit promptly.
- **`ctx.retry({ delay?, reason? })`** — returns a `RetryError` you can `throw` to reschedule the job immediately (bypassing `retryOn`/`noRetryOn` filters).
- **`ctx.attempt`** — current attempt number (1-indexed).

See the main [Job Context](/guide/job-context) guide for the full surface.

## Schema validation

If the contract has a Standard Schema (Zod, Valibot, ArkType) attached via `defineTask({ input, output })`, taskora runs validation on both sides automatically:

- **Producer**: `TaskoraRef.for(contract).dispatch(data)` validates `data` against `input` before enqueueing (can be disabled globally via `validateOnDispatch: false` or per-call via `dispatch(data, { skipValidation: true })`).
- **Worker**: after deserialization and migration, taskora validates `data` against `input` again before calling `process()`. If the contract also has an `output` schema, the value returned from `process()` is validated before being stored as the result.

Validation errors are regular `ValidationError` throws — they go through the normal retry machinery and end up in the DLQ if `attempts` is exhausted. You don't need to validate inside `process()` — by the time it runs, `data` is already typed and proven to match the schema.

## `@OnTaskEvent` — event bindings

Method-level decorator that wires a consumer method to a per-task event on the same Task that the consumer handles:

```ts
import { OnTaskEvent, TaskConsumer } from "@taskora/nestjs"

@TaskConsumer(sendEmailTask)
export class SendEmailConsumer {
  constructor(
    private readonly mailer: MailerService,
    private readonly metrics: MetricsService,
  ) {}

  async process(data: InferInput<typeof sendEmailTask>) {
    return this.mailer.send(data)
  }

  @OnTaskEvent("completed")
  onDone(evt: Taskora.TaskEventMap<InferOutput<typeof sendEmailTask>>["completed"]) {
    this.metrics.counter("email.sent").inc()
    this.metrics.histogram("email.duration_ms").observe(Number(evt.duration))
  }

  @OnTaskEvent("failed")
  onFail(evt: Taskora.TaskEventMap<never>["failed"]) {
    this.metrics.counter("email.failed", { reason: evt.error }).inc()
  }

  @OnTaskEvent("retrying")
  onRetry(evt: Taskora.TaskEventMap<never>["retrying"]) {
    this.metrics.counter("email.retried").inc()
  }
}
```

Valid event names match the keys of `Taskora.TaskEventMap`:

| Event | Payload | When |
|---|---|---|
| `completed` | `{ result, duration, attempt }` | Handler returned successfully |
| `failed` | `{ error, attempt, willRetry }` | Handler threw (with or without retry) |
| `retrying` | `{ error, attempt, nextAttemptAt }` | Handler threw and is being retried |
| `progress` | `{ value, timestamp }` | Handler called `ctx.progress(...)` |
| `active` | `{ jobId, attempt }` | Job transitioned to active state |
| `stalled` | `{ count, action }` | Stall detection recovered or failed a job |
| `cancelled` | `{ reason, cancelledAt }` | `handle.cancel()` was called |

### DI still works in event handlers

`@OnTaskEvent` methods run on the same consumer instance as `process()`. The explorer binds each method via `instance[method].bind(instance)`, so `this.metrics` and `this.mailer` resolve normally inside event handlers — there's no detached context, no separate instance per event.

### App-level events

`@OnTaskEvent` only wires **per-task** events. For cross-task app events (`worker:ready`, `worker:error`, `task:completed` across all tasks), inject the raw `App` and subscribe manually from a dedicated service:

```ts
import { Injectable, OnModuleInit } from "@nestjs/common"
import { InjectApp } from "@taskora/nestjs"
import type { App } from "taskora"

@Injectable()
export class WorkerHealthService implements OnModuleInit {
  constructor(@InjectApp() private readonly app: App) {}

  onModuleInit() {
    this.app.on("worker:ready", () => this.markHealthy())
    this.app.on("worker:error", (err) => this.reportError(err))
  }
}
```

## Lifecycle ordering

The explorer runs its discovery pass **inside** `onApplicationBootstrap`. The sequence for every named app is:

1. Nest resolves all providers (constructors run, DI is wired).
2. Explorer walks providers via `DiscoveryService.getProviders()`.
3. For each `@TaskConsumer`, explorer calls `app.implement(contract, handler, options)`.
4. For each `@OnTaskEvent` method on that consumer, explorer calls `task.on(event, boundHandler)`.
5. Explorer calls `app.start()` (unless `autoStart: false`).
6. Worker loop begins pulling jobs.

The ordering is guaranteed: **all `implement()` calls finish before `start()` runs**. You can't get a race where a worker picks up a job for a contract whose handler hasn't been attached yet.

On `onApplicationShutdown` the explorer awaits `app.close()`, which drains in-flight jobs up to the stall timeout and then returns. Make sure `app.enableShutdownHooks()` is called in `main.ts` so SIGTERM triggers the shutdown sequence.

## Consumer-owned scheduling

A consumer can declare a schedule via the explorer's option passthrough — but actually, `TaskConsumer` options do **not** accept `schedule` at the moment. Use `app.schedule()` from a separate `OnModuleInit` provider or define the schedule at the task contract level via `defineTask`. Schedule discovery on consumers is tracked for a future release — see the [Scheduling](/features/scheduling) docs for the direct-taskora path.

## Error handling inside `process()`

Throw normally. taskora's retry machinery handles everything:

```ts
async process(data: InferInput<typeof importTask>) {
  try {
    return await this.importer.run(data)
  } catch (err) {
    if (err instanceof TransientError) {
      // Let taskora retry per the consumer's retry config
      throw err
    }
    if (err instanceof PermanentError) {
      // Opt out of retries — goes to DLQ immediately
      throw new RetryError({ retry: false, reason: err.message })
    }
    throw err // default — respects retry config
  }
}
```

- **Regular throws** go through the `retry.attempts` / `backoff` / `retryOn` / `noRetryOn` machinery.
- **`ctx.retry({ delay, reason })`** returns a `RetryError` that bypasses filters — always retries, with the given delay.
- **`new RetryError({ retry: false })`** short-circuits the retry machinery entirely, sending the job to the DLQ on first failure.
- **`TimeoutError`** (when the consumer's `timeout` fires) is **not** retried by default — add `"TimeoutError"` to `retryOn` if you want it retried.

## Testing consumers

Consumers are regular Nest providers, so `@nestjs/testing`'s `Test.createTestingModule` just works. For end-to-end coverage that actually runs the handler, use [`@taskora/nestjs/testing`](./testing):

```ts
import { createTaskoraTestHarness } from "@taskora/nestjs/testing"

it("sends the welcome email", async () => {
  const harness = await createTaskoraTestHarness({
    providers: [SendEmailConsumer, MailerService],
  })

  const result = await harness.execute(sendEmailTask, {
    to: "alice@example.com",
    subject: "Welcome",
  })

  expect(result.state).toBe("completed")
  expect(result.result?.messageId).toBeDefined()

  await harness.close()
})
```

See the [Testing](./testing) page for the full patterns — the harness runs the real explorer + real consumers + real DI in-memory.
