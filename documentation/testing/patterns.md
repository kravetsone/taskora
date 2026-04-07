# Test Patterns

Common patterns for testing taskora tasks effectively.

## Testing Retry Behavior

```ts
import { describe, it, expect, afterEach } from "vitest"
import { createTestRunner } from "taskora/test"

const runner = createTestRunner()
afterEach(() => runner.clear())

it("retries on transient errors", async () => {
  let callCount = 0
  const flakyTask = runner.app.task("flaky", {
    retry: { attempts: 3, backoff: "fixed", delay: 100 },
    handler: async () => {
      callCount++
      if (callCount < 3) throw new Error("Transient failure")
      return "success"
    },
  })

  const result = await runner.execute(flakyTask, {})
  expect(result.state).toBe("completed")
  expect(result.attempts).toBe(3)
  expect(result.result).toBe("success")
})
```

## Testing with `from: taskora`

Patch all tasks from a production instance to test inter-task interactions:

```ts
import { taskora, processOrderTask, sendConfirmationTask } from "../src/tasks"

const runner = createTestRunner({ from: taskora })
afterEach(() => runner.dispose())

it("processes order and sends confirmation", async () => {
  // processOrder dispatches sendConfirmation internally
  const result = await runner.execute(processOrderTask, {
    orderId: "123",
    items: [{ sku: "ABC", quantity: 1 }],
  })

  expect(result.state).toBe("completed")
  // The confirmation email was also dispatched and processed in-memory
})
```

## Testing Middleware

```ts
it("middleware transforms data", async () => {
  const logs: string[] = []

  const mwTestTask = runner.app.task("mw-test", {
    middleware: [
      async (ctx, next) => {
        logs.push("before")
        await next()
        logs.push("after")
      },
    ],
    handler: async (data: string) => {
      logs.push("handler")
      return data.toUpperCase()
    },
  })

  const result = await runner.run(mwTestTask, "hello")
  expect(result).toBe("HELLO")
  expect(logs).toEqual(["before", "handler", "after"])
})
```

## Testing Progress and Logs

```ts
it("reports progress and logs", async () => {
  const progressTask = runner.app.task("progress-task", async (data: {}, ctx) => {
    ctx.progress(25)
    ctx.log.info("Quarter done")
    ctx.progress(100)
    ctx.log.info("Complete")
    return "done"
  })

  const result = await runner.execute(progressTask, {})
  expect(result.progress).toBe(100)
  expect(result.logs).toHaveLength(2)
  expect(result.logs[0].message).toBe("Quarter done")
})
```

## Testing Error Cases

```ts
it("fails permanently after max attempts", async () => {
  const alwaysFailsTask = runner.app.task("always-fails", {
    retry: { attempts: 2 },
    handler: async () => {
      throw new Error("Always fails")
    },
  })

  const result = await runner.execute(alwaysFailsTask, {})
  expect(result.state).toBe("failed")
  expect(result.attempts).toBe(2)
  expect(result.error).toContain("Always fails")
})
```

## Importing Production Tasks

Selectively import tasks from an existing instance:

```ts
const runner = createTestRunner()

runner.importTask(sendEmailTask)
runner.importTask(processImageTask)

// Only these two tasks are available in the runner
const result = await runner.execute(sendEmailTask, data)
```
