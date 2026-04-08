# Contracts

A **task contract** is a pure, serializable declaration of a task — its name, input/output schemas, and defaults — with no runtime dependency on `App`, `Worker`, or `Adapter`. Contracts let you split task *declaration* from task *implementation*.

## When to reach for contracts

The inline form — `taskora.task("send-email", { handler, input, output })` — ties declaration and implementation together in a single call. That's the **default and correct choice for most projects**. If producer and worker live in the same process, inline tasks are simpler, give you the same type safety, and compose into workflows identically. Don't use contracts just because they sound cleaner.

Contracts exist to solve one specific problem: **the producer needs to dispatch a job, but can't import the handler**. This happens when:

- The worker's handler has heavy runtime dependencies (`sharp`, `puppeteer`, `ffmpeg`, native bindings, large ML models) that you don't want in the API server bundle.
- The producer runs somewhere the handler physically can't run — edge runtime, browser, serverless with cold-start budget.
- Multiple services dispatch to the same worker pool, and each service would otherwise need to duplicate the input/output types manually.

In those cases, inline tasks force the producer to import the handler file and its entire transitive dependency graph. Contracts fix that: the contract is the shared surface, handlers live only where they're needed.

If none of the above applies, stay with inline `taskora.task()` — contracts add a layer of indirection you don't need.

## `defineTask()`

Create a contract with runtime schemas. Types are inferred from any [Standard Schema](https://standardschema.dev) compatible library — Zod, Valibot, ArkType, etc.

```ts
// contracts/tasks.ts — shared between producer and worker
import { defineTask } from "taskora"
import { z } from "zod"

export const sendEmailTask = defineTask({
  name: "send-email",
  input: z.object({
    to: z.string().email(),
    subject: z.string(),
    body: z.string(),
  }),
  output: z.object({ messageId: z.string() }),
  retry: { attempts: 3, backoff: "exponential" },
  timeout: "30s",
})
```

`defineTask` returns a `TaskContract<TInput, TOutput>` — a plain object with the task's metadata. It has no `dispatch()` method by itself: to dispatch, you bind the contract to an `App` via `register()` or `implement()`.

Contract fields that make sense on both sides of the split (retry, timeout, stall, version) can live in the contract as defaults. Worker-side overrides are applied at `implement()` time.

## `staticContract()`

For bundle-size-sensitive producers — edge runtimes, browsers, serverless functions where shipping Zod or Valibot at runtime is a cost you don't want — `staticContract<I, O>` creates a typeless contract with no runtime schemas:

```ts
import { staticContract } from "taskora"

export const sendEmailTask = staticContract<
  { to: string; subject: string; body: string },
  { messageId: string }
>({ name: "send-email" })
```

Same API surface as `defineTask`, but the input/output types live purely at the type level. The worker still validates — workers always run schema validation before the handler, independent of what the producer shipped. The safety net is at the worker boundary, not producer.

## Producer side — `taskora.register()`

A producer process never runs a handler. It registers the contract to get a dispatchable `BoundTask`:

```ts
// api/server.ts — producer (no handler imports)
import { createTaskora } from "taskora"
import { redisAdapter } from "taskora/redis"
import { sendEmailTask } from "../contracts/tasks.js"

const taskora = createTaskora({ adapter: redisAdapter(process.env.REDIS_URL!) })
const sendEmail = taskora.register(sendEmailTask)

// Fully typed: TypeScript enforces { to, subject, body }
const handle = sendEmail.dispatch({
  to: "alice@example.com",
  subject: "Welcome",
  body: "...",
})

const result = await handle.result // { messageId: string }
```

`register()` is **idempotent by task name**: calling it twice for the same contract returns the same underlying `BoundTask`. Existing tasks declared inline via `taskora.task()` can also be wrapped — `register()` never overwrites or conflicts.

Producer processes can still call `taskora.start()`. The worker loop simply skips tasks that have no handler — dispatch and event subscription keep working as normal.

## Worker side — `taskora.implement()`

A worker attaches a handler to a contract with `taskora.implement()`. Three call forms, pick whichever fits:

### Bare handler

The common case. Data and result types are inferred from the contract's schemas.

```ts
// worker/main.ts
import { createTaskora } from "taskora"
import { redisAdapter } from "taskora/redis"
import { sendEmailTask } from "../contracts/tasks.js"
import { mailer } from "./mailer.js"

const taskora = createTaskora({ adapter: redisAdapter(process.env.REDIS_URL!) })

taskora.implement(sendEmailTask, async (data, ctx) => {
  ctx.log.info("sending", { to: data.to })
  const { id } = await mailer.send(data)
  return { messageId: id }
})

await taskora.start()
```

### Handler + worker-side options

Worker-only config (concurrency, middleware, onCancel, migrations, singleton, concurrencyLimit, ttl) goes in the third argument.

```ts
taskora.implement(
  processImageTask,
  async (data, ctx) => {
    const result = await sharp(data.url).resize(data.width).toBuffer()
    return { key: await s3.put(result) }
  },
  {
    concurrency: 4,
    middleware: [withTracing(), withMetrics()],
    version: 3,
    migrate: [
      (v1) => ({ ...v1, width: v1.w }),
      (v2) => ({ ...v2, width: v2.width ?? 800 }),
    ],
  },
)
```

### Object form

Required for [collect tasks](/guide/tasks#collect-tasks) (the handler signature is `(items: I[], ctx) => ...` instead of `(data: I, ctx) => ...`), and cleaner when the config is larger than the handler body.

```ts
taskora.implement(batchEmailTask, {
  collect: { key: "user-emails", delay: "5s", maxSize: 100 },
  handler: async (items, ctx) => {
    await mailer.sendBatch(items)
    return { sent: items.length }
  },
})
```

`implement()` throws if called twice for the same contract in the same process. Calling `implement()` after `register()` is **not** a double-implement — it's the intended upgrade path. The existing `BoundTask` returned by `register()` is updated in place and keeps working.

## Workflow composition from contracts

Once registered or implemented, contract-based `BoundTask`s compose into workflows identically to inline tasks:

```ts
import { chain, group, chord } from "taskora"
import { fetchUserTask, renderTemplateTask, sendEmailTask } from "../contracts/tasks.js"

const fetchUser = taskora.register(fetchUserTask)
const renderTemplate = taskora.register(renderTemplateTask)
const sendEmail = taskora.register(sendEmailTask)

// Producer-side composition — no handler code needed
const handle = chain(
  fetchUser.s({ id: "42" }),
  renderTemplate.s(),
  sendEmail.s(),
).dispatch()

await handle.result
```

The workflow's individual jobs run on whichever process has implemented each contract. A single workflow can span multiple worker deployments — jobs are matched to workers by task name.

## Validation knob — `validateOnDispatch`

By default, `dispatch()` validates input against the task's Standard Schema before enqueueing. Two ways to disable:

```ts
// Global — disables for every dispatch in this app
const taskora = createTaskora({
  adapter: redisAdapter(url),
  validateOnDispatch: false,
})

// Per-call — overrides the global default
sendEmail.dispatch(data, { skipValidation: true })
```

**Worker-side validation is unaffected.** Workers always run schema validation before the handler, so job data is still checked at some boundary. Disable producer-side validation when:

- The producer has already validated upstream (e.g. tRPC / a REST framework validated the request body).
- The producer uses `staticContract()` and has no schema to run.
- You're profiling and have measured validation cost as a bottleneck.

## When to pick which declaration style

| | Inline `taskora.task()` | Contract-based |
|---|---|---|
| Monolith (API + workers in one process) | ✅ simpler | also works |
| Web API + separate worker deployment | handler leaks into API bundle | ✅ clean split |
| Multi-package monorepo (`workspace:*`) | requires duplicating types | ✅ contracts go in `packages/contracts` |
| Edge runtime / browser producer | ❌ handler deps | ✅ `staticContract<I, O>()` |
| Quick prototype | ✅ less ceremony | overkill |

Both styles are first-class. You can freely mix them — for example, declare internal tasks inline and public API tasks as contracts. See [Splitting Services](/guide/splitting-services) for how to physically organize contract files across your codebase.
