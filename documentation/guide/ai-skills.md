# AI Skills

Taskora ships a public **Claude Code skill** that gives AI assistants deep knowledge of the library — every API, pattern, flow, and best practice. Instead of guessing from training data, your AI gets a structured reference tuned to taskora's conventions.

## What's included

The `/taskora` skill provides:

- **Full API reference** — `createTaskora()`, `app.task()`, `dispatch()`, `chain/group/chord`, events, inspector, DLQ, board
- **Internal flows** — job lifecycle state machine, worker processing pipeline, retry decision tree, workflow DAG execution, scheduling loop, cancellation and stall detection flows
- **Best practices** — production checklist, idempotent handlers, timeout/signal propagation, flow control selection guide, retry anti-patterns, testing strategy, graceful shutdown
- **Type system** — `Taskora` namespace, all public interfaces, adapter abstraction

## Installation

### Claude Code

::: code-group
```bash [Quick install]
npx skills add kravetsone/taskora/documentation/skills
```

```bash [Specific skill only]
npx skills add kravetsone/taskora/documentation/skills --all
```
:::

Or install manually — copy `documentation/skills/using-taskora/SKILL.md` from the [taskora repo](https://github.com/kravetsone/taskora) into your project's `.claude/skills/` directory:

```bash
mkdir -p .claude/skills/using-taskora
curl -o .claude/skills/using-taskora/SKILL.md \
  https://raw.githubusercontent.com/kravetsone/taskora/main/documentation/skills/using-taskora/SKILL.md
```

### Other AI assistants

Taskora generates machine-readable documentation compatible with any LLM:

| File | Description |
|---|---|
| [`/llms.txt`](/llms.txt) | Table of contents with links to all documentation pages |
| [`/llms-full.txt`](/llms-full.txt) | Complete documentation as a single text file |

Append `.md` to any documentation URL to get raw markdown.

## What the skill covers

| Area | Topics |
|---|---|
| **Setup** | `createTaskora()`, `redisAdapter()`, `memoryAdapter()`, adapter pattern |
| **Tasks** | `app.task()`, handler signature, options, `Task<TInput, TOutput>` |
| **Dispatching** | `dispatch()`, `dispatchMany()`, `ResultHandle`, dispatch options |
| **Context** | `ctx.id`, `ctx.signal`, `ctx.progress()`, `ctx.log`, `ctx.heartbeat()`, `ctx.retry()` |
| **Retry** | `RetryConfig`, backoff strategies, `retryOn`/`noRetryOn`, `RetryError`, `TimeoutError` |
| **Schemas** | Standard Schema validation, input/output, Zod/Valibot/ArkType |
| **Versioning** | `version`, `since`, `migrate` (tuple + record), `into()` helper, inspector |
| **Scheduling** | `app.schedule()`, inline schedules, cron, duration type, missed policy, leader election |
| **Workflows** | `chain()`, `group()`, `chord()`, `.pipe()`, `.map()`, `.chunk()`, `WorkflowHandle`, DAG model |
| **Events** | Task events, app events, `subscribe()`, default error logging |
| **Middleware** | `app.use()`, per-task middleware, Koa-style onion, `MiddlewareContext` |
| **Flow control** | Debounce, throttle, deduplicate, TTL, singleton, concurrency key, collect |
| **Cancellation** | `handle.cancel()`, `onCancel` hook, `CancelledError`, pub/sub detection |
| **Inspector** | `active()`, `waiting()`, `delayed()`, `stats()`, `find()`, typed variants |
| **DLQ** | `deadLetters.list()`, `.retry()`, `.retryAll()` |
| **Testing** | `createTestRunner()`, `run()` vs `execute()`, from-instance mode, workflow testing |
| **Board** | `createBoard()`, REST API, SSE, framework integration |
| **Flows** | Job lifecycle, worker pipeline, retry decision tree, workflow DAG, scheduling, stall detection |

## How it works

When the skill is installed, Claude Code automatically activates it when you:

- Ask about taskora APIs or patterns
- Write or modify task handlers
- Set up scheduling, workflows, or flow control
- Debug retry behavior or job state issues
- Write tests using `taskora/test`

The skill is a single markdown file (`SKILL.md`) with structured frontmatter. Claude Code reads it on activation and uses the reference to generate accurate, convention-following code.

## Example prompts

Once the skill is installed, try:

- *"Create a task that processes images with retry on network errors and progress reporting"*
- *"Set up a workflow: fetch data from 3 APIs in parallel, then merge results"*
- *"Add debounced reindexing that batches updates within 5s"*
- *"Write tests for my order processing task including retry scenarios"*
- *"Configure scheduling with cron for daily cleanup at 2am UTC"*
