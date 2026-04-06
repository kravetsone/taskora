# run() vs execute()

The test runner offers two execution modes with different trade-offs.

## `runner.run(task, data)`

**Direct handler execution** — calls the handler function directly with a mock context, including an inline retry loop.

```ts
const result = await runner.run(sendEmail, { to: "user@example.com", subject: "Hi" })
```

### Characteristics

- Calls handler directly (no queue)
- Retries inline in the same call
- Returns the handler's return value
- Fastest — zero queue overhead
- Schema validation still runs
- Middleware still runs

### Best For

- Unit testing handler logic
- Testing schema validation
- Testing middleware behavior
- Quick smoke tests

## `runner.execute(task, data)`

**Full pipeline execution** — dispatches through the memory adapter, processes the job, auto-advances time for retries.

```ts
const execution = await runner.execute(sendEmail, {
  to: "user@example.com",
  subject: "Hi",
})

console.log(execution.state)    // "completed"
console.log(execution.attempts) // 1
console.log(execution.result)   // { messageId: "..." }
console.log(execution.logs)     // [{ level: "info", message: "...", ... }]
console.log(execution.progress) // 100
console.log(execution.error)    // undefined
```

### Characteristics

- Full dispatch → dequeue → process → ack/fail pipeline
- Auto-advances virtual time for delayed jobs and retries
- Returns `ExecutionResult` with full telemetry
- State transitions match production behavior
- Slower than `run()` but more realistic

### Best For

- Integration testing the full job lifecycle
- Testing retry behavior with backoff
- Verifying state transitions
- Testing progress and log output
- Testing delayed jobs

## Comparison Table

| | `run()` | `execute()` |
|---|---|---|
| Queue involved | No | Yes |
| Retries | Inline loop | Via delayed queue + auto-advance |
| Returns | Handler result | `ExecutionResult` with metadata |
| Speed | Fast | Moderate |
| Schema validation | Yes | Yes |
| Middleware | Yes | Yes |
| Progress tracking | No | Yes |
| Log capture | No | Yes |
| State inspection | No | Yes |
