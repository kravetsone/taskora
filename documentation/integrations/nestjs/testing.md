# Testing

`@taskora/nestjs/testing` is an opt-in subpath that ships two helpers for unit-testing Nest modules that use taskora:

- **`TaskoraTestingModule.forRoot()`** — drop-in replacement for `TaskoraModule.forRoot` with memory-adapter defaults. Use it when you want to assert on DI wiring without running jobs.
- **`createTaskoraTestHarness({ providers })`** — higher-level builder that compiles a testing module, boots the real App (memory adapter + real worker loop + real subscribe stream), and returns a harness with `dispatch` / `execute` / `inspect` / `close` methods.

Both reuse the **production** `TaskoraExplorer` / consumer registration path. You're not testing a parallel fake — you're driving the real code over an in-memory adapter.

## Import

```ts
import {
  createTaskoraTestHarness,
  TaskoraTestHarness,
  TaskoraTestingModule,
  type ExecuteResult,
} from "@taskora/nestjs/testing"
```

## DX comparison

### Without the harness (manual pattern)

```ts
it("sends the welcome email", async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      TaskoraModule.forRoot({ adapter: memoryAdapter(), autoStart: false }),
    ],
    providers: [SendEmailConsumer, MailerService],
  }).compile()
  await moduleRef.init()

  // To test anything useful you have to spy on App.prototype.implement
  // and invoke the captured handler by hand — or set autoStart: true
  // and manually wire a TaskoraRef dispatch with await handle.result.
  // Either way: boilerplate.

  await moduleRef.close()
})
```

### With the harness

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

## What `createTaskoraTestHarness` does

1. Compiles a Nest `TestingModule` with `TaskoraTestingModule.forRoot({ autoStart: true })` pre-imported.
2. Calls `moduleRef.init()`, which runs `TaskoraExplorer.onApplicationBootstrap`:
   - Every `@TaskConsumer` in your providers gets `app.implement(contract, handler)` called with the DI-managed instance's `process` bound as the handler.
   - Every `@OnTaskEvent` method gets wired via `task.on(event, …)`.
   - Every class middleware gets resolved and registered via `app.use(...)`.
   - `app.start()` runs, spinning up the worker loop and subscribe stream.
3. Resolves `TaskoraRef` from the DI graph.
4. Returns a `TaskoraTestHarness` that routes `dispatch` / `execute` through the same running App.

The worker loop runs against the memory adapter (taskora's memory backend implements proper blocking dequeue, so there's no busy-spin and `close()` is clean). Subscribe runs against the same adapter. **`@OnTaskEvent` bindings fire exactly like in production** — they aren't simulated.

## Harness API

### `dispatch(contract, data, options?)`

Fire-and-forget dispatch. Returns a `ResultHandle<TOutput>` synchronously — await `handle.result` to wait for processing:

```ts
const handle = harness.dispatch(processImageTask, { url: "..." })
const { width } = await handle.result
```

### `execute(contract, data, options?)`

Dispatch + wait for terminal state + return a compact `ExecuteResult<TOutput>`:

```ts
interface ExecuteResult<TOutput> {
  id: string
  state: Taskora.JobState            // "completed" | "failed" | "cancelled" | "expired"
  result: TOutput | undefined
  error: string | undefined
  attempts: number
  logs: Taskora.LogEntry[]
  progress: number | Record<string, unknown> | undefined
  timeline: { dispatched: number; processed?: number; finished?: number }
}
```

**Errors are not re-thrown.** If the handler throws and retries are exhausted, `state === "failed"` and `error` carries the message:

```ts
it("retries a flaky handler up to the configured limit", async () => {
  harness = await createTaskoraTestHarness({
    providers: [FlakyConsumer],
  })

  const result = await harness.execute(flakyTask, { boom: true })

  expect(result.state).toBe("failed")
  expect(result.error).toMatch(/boom/)
  expect(result.attempts).toBe(3)        // 1 initial + 2 retries
})
```

### `inspect(contract, jobId)`

Full `JobInfo` record from the inspector — data, result, logs, progress, timeline, attempt history:

```ts
const handle = harness.dispatch(sendEmailTask, { to: "bob@x" })
await handle.result
const info = await harness.inspect(sendEmailTask, handle.id)
expect(info?.logs).toContainEqual(expect.objectContaining({ message: "sending" }))
```

### `close()`

Tears down the Nest testing module, which runs `TaskoraExplorer.onApplicationShutdown` → `app.close()`. Workers drain, subscribe stops, Redis connections (or memory backend timers) clean up. Always call this in a test `afterEach` / `finally`.

## Accessing `moduleRef` and `app`

The harness exposes the underlying testing module, the raw App, and a `TaskoraRef` for tests that need finer control:

```ts
harness.moduleRef   // Nest TestingModule — use .get(Class) to resolve providers
harness.app         // raw taskora App — for inspector, dlq, schedules access
harness.tasks       // TaskoraRef — same one your services get via DI
```

Use `harness.moduleRef.get(SomeService)` to assert on service state after a job runs:

```ts
await harness.execute(sendEmailTask, { to: "alice@x", subject: "Hi" })
const mailer = harness.moduleRef.get(MailerService)
expect(mailer.sent).toEqual(["alice@x"])
```

## Verifying `@OnTaskEvent` fires

Because the harness runs the real subscribe stream, event bindings fire naturally:

```ts
@TaskConsumer(sendEmailTask)
class SendEmailConsumer {
  completedCount = 0

  async process(data: { to: string }) {
    return { sent: true, messageId: "abc" }
  }

  @OnTaskEvent("completed")
  onDone() {
    this.completedCount += 1
  }
}

it("fires @OnTaskEvent('completed') on success", async () => {
  const harness = await createTaskoraTestHarness({
    providers: [SendEmailConsumer],
  })

  await harness.execute(sendEmailTask, { to: "alice@x" })

  const consumer = harness.moduleRef.get(SendEmailConsumer)
  expect(consumer.completedCount).toBeGreaterThanOrEqual(1)

  await harness.close()
})
```

## `TaskoraTestingModule` — the lower-level primitive

If you want a Nest testing module without the harness abstraction (e.g. for tests that don't dispatch jobs at all — just verify providers resolve, or sanity-check that your module imports `TaskoraModule` correctly):

```ts
import { Test } from "@nestjs/testing"
import { TaskoraTestingModule } from "@taskora/nestjs/testing"

it("wires the EmailService with its TaskoraRef", async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [TaskoraTestingModule.forRoot()], // memory adapter + autoStart: false
    providers: [EmailService, MailerService],
  }).compile()

  await moduleRef.init()

  const svc = moduleRef.get(EmailService)
  expect(svc).toBeDefined()

  await moduleRef.close()
})
```

Defaults:
- `adapter` → `memoryAdapter()`
- `autoStart` → `false` (no worker, no subscribe — just DI wiring)

Override either to run integration-style tests against a real Redis or to start the App explicitly.

## Custom `imports` and taskora options

`createTaskoraTestHarness` accepts the full Nest `ModuleMetadata` plus a `taskora` field for the underlying `TaskoraTestingModule.forRoot` options:

```ts
const harness = await createTaskoraTestHarness({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot({ type: "sqlite", database: ":memory:" }),
  ],
  providers: [SendEmailConsumer, MailerService, UserRepository],
  taskora: {
    // Override taskora defaults for this test
    middleware: [LoggingMiddleware],
    defaults: { retry: { attempts: 1 } },   // fail fast in tests
  },
})
```

This lets you compose the harness with any other Nest module the consumer depends on (config, TypeORM, Prisma, etc.) without losing the taskora wiring.

## Snapshot: vitest config for decorator metadata

The harness drives real DI, which means the test runner must emit decorator metadata (`experimentalDecorators` + `emitDecoratorMetadata` equivalents). Vitest's default esbuild transform **does not** emit metadata — consumers inject as `undefined` and every job throws.

The fix is one plugin. Install it:

::: pm-add -D unplugin-swc @swc/core
:::

And wire it in `vitest.config.ts`:

```ts
import swc from "unplugin-swc"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    setupFiles: ["./tests/setup.ts"],
  },
})
```

Plus a one-liner setup file loading reflect-metadata:

```ts
// tests/setup.ts
import "reflect-metadata"
```

Without this, you'll see cryptic "cannot read property 'for' of undefined" errors inside services that inject `TaskoraRef`. Production builds (tsc, swc, nest build) emit metadata by default — only Vitest's default transform skips it.

## Virtual time

The harness uses real time. If you need virtual time (fast-forwarding delayed jobs, testing schedules, deterministic retries), drop down to taskora's own [`taskora/test`](/testing/virtual-time) subpath directly — construct a fresh `App` and wrap it in `createTestRunner()`. The harness deliberately doesn't try to merge the two worlds because dual-backend setups (runner's backend vs subscribe's backend) are easy to get wrong.

Typical split:

- **Harness** — end-to-end DI tests, `@TaskConsumer` integration, `@OnTaskEvent` bindings, middleware chains.
- **`taskora/test` `createTestRunner`** — schedule tests, retry backoff timing, flow-control (debounce/throttle/dedupe), workflow composition.

## Integration testing against real Redis

If you want to test against a real Redis (e.g. in CI with a service container or testcontainers), pass the real adapter via `taskora.adapter`:

```ts
import { redisAdapter } from "taskora/redis"
import { Redis } from "ioredis"

beforeAll(async () => {
  redis = new Redis(process.env.REDIS_URL!)
})

afterAll(async () => {
  await redis.quit()
})

it("runs against a real Redis container", async () => {
  const harness = await createTaskoraTestHarness({
    providers: [SendEmailConsumer, MailerService],
    taskora: {
      adapter: redisAdapter({ client: redis }),
    },
  })

  const result = await harness.execute(sendEmailTask, { to: "alice@x" })
  expect(result.state).toBe("completed")

  await harness.close()
})
```

The rest of the harness API is unchanged — only the adapter swap differs between unit and integration tests.
