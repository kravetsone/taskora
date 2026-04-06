# Tasks

A task is a named function with configuration. Taskora provides three ways to define tasks, from minimal to fully configured.

## Minimal Definition

Pass a name and a handler. Types are inferred automatically.

```ts
const greet = app.task("greet", async (data: { name: string }) => {
  return `Hello, ${data.name}!`
})

// TypeScript knows: dispatch expects { name: string }, result is string
const handle = greet.dispatch({ name: "Alice" })
const result = await handle.result // "Hello, Alice!"
```

## With Options

Pass an options object for retry, timeout, concurrency, and more.

```ts
const sendEmail = app.task("send-email", {
  concurrency: 5,
  timeout: 30_000,
  retry: {
    attempts: 3,
    backoff: "exponential",
    delay: 1000,
  },
  handler: async (data: { to: string; subject: string }, ctx) => {
    ctx.log.info("Sending email", { to: data.to })
    return await mailer.send(data)
  },
})
```

## With Schema Validation

Use any [Standard Schema](https://github.com/standard-schema/standard-schema) compatible library (Zod, Valibot, ArkType) for runtime validation.

```ts
import { z } from "zod"

const processOrder = app.task("process-order", {
  input: z.object({
    orderId: z.string().uuid(),
    items: z.array(z.object({
      sku: z.string(),
      quantity: z.number().int().positive(),
    })),
  }),
  output: z.object({
    total: z.number(),
    status: z.enum(["confirmed", "pending"]),
  }),
  handler: async (data, ctx) => {
    // data is fully typed: { orderId: string, items: { sku: string, quantity: number }[] }
    const total = await calculateTotal(data.items)
    return { total, status: "confirmed" as const }
  },
})
```

Schema validation runs **after** migrations (if versioned) and provides clear `ValidationError` with an `issues` array on failure.

## Task Options Reference

| Option | Type | Default | Description |
|---|---|---|---|
| `concurrency` | `number` | `1` | Max parallel jobs per worker |
| `timeout` | `number` | `undefined` | Handler timeout in ms |
| `retry` | `RetryConfig` | `undefined` | Retry configuration |
| `stall` | `StallConfig` | `{ interval: 30000, maxCount: 1 }` | Stall detection config |
| `singleton` | `boolean` | `false` | Only one active job at a time |
| `concurrencyLimit` | `number` | `undefined` | Max active jobs per concurrency key |
| `ttl` | `TtlConfig` | `undefined` | Job time-to-live |
| `middleware` | `Middleware[]` | `[]` | Per-task middleware |
| `onCancel` | `(data, ctx) => void` | `undefined` | Cleanup on cancellation |
| `version` | `number` | `1` | Current task version |
| `since` | `number` | `1` | Minimum supported version |
| `migrate` | `MigrationFn[]` \| `Record` | `undefined` | Version migrations |
| `input` | `StandardSchema` | `undefined` | Input validation schema |
| `output` | `StandardSchema` | `undefined` | Output validation schema |
| `schedule` | `ScheduleConfig` | `undefined` | Inline schedule |
| `collect` | `CollectConfig` | `undefined` | Batch collection |

## Collect Tasks

Collect tasks accumulate items into batches before processing. The handler receives an array.

```ts
const batchInsert = app.task("batch-insert", {
  collect: {
    key: "db-inserts",
    delay: "2s",        // flush 2s after last item
    maxSize: 100,       // or when 100 items accumulated
    maxWait: "10s",     // or 10s since first item (hard deadline)
  },
  handler: async (items: { table: string; row: Record<string, unknown> }[], ctx) => {
    ctx.log.info(`Inserting ${items.length} rows`)
    await db.batchInsert(items)
    return { inserted: items.length }
  },
})

// Dispatch individual items — they accumulate automatically
batchInsert.dispatch({ table: "users", row: { name: "Alice" } })
batchInsert.dispatch({ table: "users", row: { name: "Bob" } })
```

Three flush triggers (whichever fires first):
1. **Debounce delay** — reset on each new item
2. **maxSize** — immediate flush when buffer is full
3. **maxWait** — hard deadline since first item after last flush
