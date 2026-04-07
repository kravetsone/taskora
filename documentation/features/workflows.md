# Workflows

Compose tasks into pipelines — sequential chains, parallel groups, and fan-in chords. Inspired by Celery's Canvas, with full TypeScript type safety.

## Signatures

A **Signature** is a snapshot of a task invocation — serializable and composable.

```ts
const sig = sendEmailTask.s({ to: "a@b.com", subject: "Welcome" })
// Type: Signature<{ to: string; subject: string }, { messageId: string }>
```

Two forms:

| Call | Behavior |
|---|---|
| `task.s(data)` | Bound data — ignores pipeline input |
| `task.s()` | Unbound — receives previous step's output |

## Chain

Sequential pipeline. Each step's output flows as input to the next. TypeScript checks the entire chain at compile time.

```ts
import { chain } from "taskora"

const onboarding = chain(
  createUserTask.s({ name: "John", email: "john@example.com" }),
  // ^ returns { id: string }
  sendWelcomeEmailTask.s(),
  // ^ receives { id: string }, returns { messageId: string }
  notifySlackTask.s(),
  // ^ receives { messageId: string }
)

const handle = onboarding.dispatch()
const result = await handle.result
```

### Pipe Syntax

Fluent alternative with unlimited type-safe chaining:

```ts
const result = await createUserTask
  .s({ name: "John", email: "john@example.com" })
  .pipe(sendWelcomeEmailTask.s())
  .pipe(notifySlackTask.s())
  .dispatch()
  .result
```

`chain()` provides type overloads for up to 10 steps. `.pipe()` has no limit — each call is individually type-checked.

## Group

Parallel execution. All signatures run concurrently, result is a typed tuple.

```ts
import { group } from "taskora"

const handle = group(
  processImageTask.s({ url: "img1.jpg", width: 800 }),
  processImageTask.s({ url: "img2.jpg", width: 800 }),
  processImageTask.s({ url: "img3.jpg", width: 800 }),
).dispatch()

const result = await handle.result
// Type: [ImageResult, ImageResult, ImageResult]
```

## Chord

Group + callback — parallel execution, then merge. The callback receives an array of all group results.

```ts
import { chord } from "taskora"

const handle = chord(
  [
    fetchPriceTask.s({ symbol: "AAPL" }),
    fetchPriceTask.s({ symbol: "GOOG" }),
    fetchPriceTask.s({ symbol: "MSFT" }),
  ],
  calculatePortfolioTask.s(),
  // ^ receives [PriceResult, PriceResult, PriceResult]
).dispatch()
```

## Composability

Compositions are themselves valid inputs to other compositions:

```ts
const handle = chord(
  [
    chain(fetchDataTask.s({ source: "api" }), transformTask.s()),
    chain(fetchDataTask.s({ source: "db" }), transformTask.s()),
  ],
  mergeTask.s(),
).dispatch()
```

Groups work as chain steps too:

```ts
const handle = chain(
  fetchConfigTask.s({ env: "prod" }),
  group(buildFrontendTask.s(), buildBackendTask.s()),
  // ^ fans out config to both, collects results
  deployTask.s(),
  // ^ receives [FrontendResult, BackendResult]
).dispatch()
```

## Map & Chunk

Batch operations on a single task.

### Map

Dispatch one job per item, all in parallel:

```ts
const handle = processImageTask.map([
  { url: "img1.jpg", width: 800 },
  { url: "img2.jpg", width: 800 },
  { url: "img3.jpg", width: 800 },
])
const results = await handle.result
// [ImageResult, ImageResult, ImageResult]
```

Equivalent to `group(task.s(item1), task.s(item2), ...).dispatch()`.

### Chunk

Split into batches, process each batch as a parallel group, batches run sequentially:

```ts
const handle = processImageTask.chunk(largeImageList, { size: 50 })
// Processes 50 at a time, then next 50, etc.
```

## WorkflowHandle

All compositions return a `WorkflowHandle` on dispatch:

```ts
const handle = chain(a.s(data), b.s()).dispatch()

await handle                     // ensure dispatched (thenable)
const result = await handle.result  // wait for final result
const state = await handle.getState()  // "running" | "completed" | "failed" | "cancelled"

await handle.cancel({ reason: "no longer needed" })  // cascade cancel
```

### Workflow TTL

Set a timeout on the entire workflow:

```ts
const handle = chain(a.s(data), b.s(), c.s()).dispatch({
  ttl: "5m",  // auto-cancel if not completed within 5 minutes
})
```

Individual jobs still use their task-level TTL. The workflow TTL is an additional global timeout.

## How It Works

All compositions flatten to a **DAG** (directed acyclic graph) of task nodes:

```
chain(a, b, c)                     →  a → b → c
group(a, b, c)                     →  a, b, c  (all parallel)
chord([a, b], c)                   →  a ─┐
                                       b ─┤→ c
chord([chain(a,b), chain(c,d)], e) →  a → b ─┐
                                       c → d ─┤→ e
```

At dispatch:
1. DAG is built, job IDs pre-generated for all nodes
2. Workflow state is stored in Redis as a single hash
3. Root nodes (no dependencies) are enqueued immediately
4. When a job completes, the worker advances the workflow — finds ready nodes and enqueues them
5. When all terminal nodes complete, the workflow is done

Failures cascade: if any node fails permanently (no retries left), the entire workflow is marked failed and all active/pending nodes are cancelled.

## Bound Data vs Pipeline

Taskora uses a **full-bind-or-pipe** model (not partial application):

- `task.s(data)` — data is fixed, pipeline input is ignored
- `task.s()` — receives entire previous step's output as input

The first step in a chain must have bound data. Subsequent steps can either bind their own data (ignoring the pipeline) or receive from the previous step.

This keeps type checking clean: each chain junction is a single constraint (`PrevOutput extends NextInput`).

## Testing Workflows

The test runner supports workflows out of the box:

```ts
import { createTestRunner } from "taskora/test"
import { chain } from "taskora"

const runner = createTestRunner()
const addTask = runner.app.task("add", async (data: { x: number; y: number }) => data.x + data.y)
const doubleTask = runner.app.task("double", async (n: number) => n * 2)

const handle = chain(addTask.s({ x: 3, y: 4 }), doubleTask.s()).dispatch()
await handle

// Process all workflow steps
for (let i = 0; i < 10; i++) {
  await runner.processAll()
  if (await handle.getState() === "completed") break
}

const result = await handle.result // 14

// Track step execution
console.log(runner.steps)
// [
//   { workflowId: "...", nodeIndex: 0, taskName: "add", state: "completed" },
//   { workflowId: "...", nodeIndex: 1, taskName: "double", state: "completed" },
// ]
```
