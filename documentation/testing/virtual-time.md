# Virtual Time

The test runner supports virtual time advancement — test delayed jobs, retries, and schedules without waiting.

## `runner.advanceTime(duration)`

Fast-forward time to process delayed jobs and retries.

```ts
const runner = createTestRunner()

// Dispatch a delayed job
await runner.dispatch(sendEmailTask, data, { delay: 5000 })

// Nothing processed yet
expect(runner.jobs.filter((j) => j.state === "waiting")).toHaveLength(0)

// Advance time by 5 seconds
await runner.advanceTime(5000)

// Now the job is in the waiting queue
await runner.processAll()
```

## Auto-Advance in `execute()`

When using `runner.execute()`, virtual time is **automatically advanced** for retry delays. You don't need to call `advanceTime()` manually.

```ts
const result = await runner.execute(retryTask, data)
// If the task retries with exponential backoff (1s, 2s, 4s),
// execute() auto-advances time to trigger each retry attempt
expect(result.attempts).toBe(3)
expect(result.state).toBe("completed")
```

## `runner.processAll()`

Drain all waiting jobs in a single call:

```ts
await runner.dispatch(taskA, data1)
await runner.dispatch(taskA, data2)
await runner.dispatch(taskB, data3)

await runner.processAll() // processes all 3 jobs
```

## `runner.flush(task, key?)`

Force-flush collect task buffers:

```ts
await runner.dispatch(batchInsert, { table: "users", row: { name: "Alice" } })
await runner.dispatch(batchInsert, { table: "users", row: { name: "Bob" } })

// Force flush without waiting for debounce timer
await runner.flush(batchInsert, "db-inserts")
await runner.processAll()
```

## `runner.clear()`

Reset all state between tests:

```ts
afterEach(() => {
  runner.clear()
})
```

## `runner.dispose()`

Required when using `from: taskora` mode. Restores the original adapters on the instance's tasks.

```ts
const runner = createTestRunner({ from: taskora })

afterEach(() => {
  runner.dispose()
})
```

## Inspecting Jobs

```ts
// Get all jobs with their states
const jobs = runner.jobs
// [{ id: "...", task: "send-email", state: "completed", ... }]
```
