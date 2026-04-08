# Testing

Taskora ships with first-class testing utilities via `taskora/test` — no Redis, no Docker, no flaky tests.

::: tip Looking for how Taskora itself is tested?
See [Cross-runtime CI](/testing/cross-runtime). The library runs its complete 300-test integration suite against **Node 24, Node 20, Bun 1.3+ (with both ioredis and native `Bun.RedisClient`), and Deno 2.x** on every push. That is **1,500 live-Redis test runs per commit** — and the publish workflow is gated on every matrix cell being green, so no release can ship with a red runtime.
:::

## Installation

The test utilities use the in-memory adapter internally. No additional dependencies required.

```ts
import { createTestRunner } from "taskora/test"
```

## Creating a Test Runner

### Standalone Mode

Create an isolated runner for unit testing individual tasks:

```ts
import { describe, it, expect, afterEach } from "vitest"
import { createTestRunner } from "taskora/test"

const runner = createTestRunner()

afterEach(() => runner.clear())
```

### From Instance Mode

Patch all tasks from an existing instance to use the in-memory backend:

```ts
import { createTestRunner } from "taskora/test"
import { taskora, sendEmailTask, processImageTask } from "../src/tasks"

const runner = createTestRunner({ from: taskora })

afterEach(() => runner.dispose()) // restores original adapters
```

This mode is powerful — multi-task chains and inter-task dispatches work in-memory without rewriting handlers.

## Two Execution Modes

### `runner.run(task, data)` — Direct Execution

Calls the handler directly with an inline retry loop. No queue involved.

```ts
const result = await runner.run(sendEmailTask, {
  to: "test@example.com",
  subject: "Test",
})
expect(result).toEqual({ messageId: expect.any(String) })
```

Best for: **unit testing** handler logic in isolation.

### `runner.execute(task, data)` — Full Pipeline

Dispatches through the queue, processes, auto-advances retries, and returns a detailed result.

```ts
const execution = await runner.execute(sendEmailTask, {
  to: "test@example.com",
  subject: "Test",
})

expect(execution.state).toBe("completed")
expect(execution.result).toEqual({ messageId: expect.any(String) })
expect(execution.attempts).toBe(1)
expect(execution.logs).toHaveLength(1)
```

Best for: **integration testing** the full dispatch → process → result pipeline.

See [run() vs execute()](/testing/run-vs-execute) for a detailed comparison.

## ExecutionResult

```ts
interface ExecutionResult<TOutput> {
  result: TOutput | undefined
  state: JobState
  attempts: number
  logs: LogEntry[]
  progress: number | Record<string, unknown> | null
  error: string | undefined
  handle: ResultHandle<TOutput>
}
```
