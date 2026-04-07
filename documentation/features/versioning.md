# Versioning & Migrations

Taskora supports task versioning with automatic data migration — deploy new task versions without losing in-flight jobs.

## The Problem

When you change a task's input shape, jobs already in the queue have the old format. Without migration, they'll fail or produce wrong results.

## Three Levels of Versioning

### Level 1: Bump Version + Schema Defaults

If the change is additive (new optional field), just bump the version and use schema `.default()`:

```ts
const sendEmailTask = taskora.task("send-email", {
  version: 2,
  input: z.object({
    to: z.string(),
    subject: z.string(),
    priority: z.enum(["low", "normal", "high"]).default("normal"), // new field
  }),
  handler: async (data, ctx) => { /* ... */ },
})
```

Existing v1 jobs are validated — `.default("normal")` fills in the missing field.

### Level 2: Sparse Migrations

For breaking changes, add migration functions:

```ts
const sendEmailTask = taskora.task("send-email", {
  version: 3,
  since: 1,    // oldest supported version
  migrate: {
    2: (data) => ({ ...data, priority: "normal" }),           // v1 → v2
    3: (data) => ({ ...data, from: data.sender, sender: undefined }), // v2 → v3
  },
  handler: async (data, ctx) => { /* ... */ },
})
```

Migrations run in order: v1 data goes through migration 2, then migration 3.

### Level 3: Tuple Migrations (Type-Safe)

Strictest form — version is derived from `since + migrations.length`:

```ts
import { into } from "taskora"

const sendEmailTask = taskora.task("send-email", {
  since: 1,
  migrate: [
    into(v2Schema, (data) => ({ ...data, priority: "normal" })),
    into(v3Schema, (data) => ({ ...data, from: data.sender })),
  ],
  // version is automatically 3 (since:1 + 2 migrations)
  input: v3Schema,
  handler: async (data, ctx) => { /* ... */ },
})
```

The `into(schema, fn)` helper locks the return type to match the schema, catching migration errors at compile time.

## How It Works

1. `dispatch()` stamps every job with `_v = task.version`
2. Worker checks the job's version:
   - `_v > task.version` → **nack** (silently return to queue — wait for newer worker)
   - `_v < task.since` → **fail** (too old, no migration path)
   - `_v < task.version` → run migration chain, then validate
   - `_v === task.version` → validate directly
3. Schema validation runs **after** migration

## `since` — Minimum Supported Version

`since` defines the oldest job version your task can process. Bump it when you're confident all old jobs have been drained:

```ts
// Before: accepts v1, v2, v3
{ version: 3, since: 1, migrate: { 2: fn, 3: fn } }

// After draining old jobs: only v2+ supported
{ version: 3, since: 2, migrate: { 3: fn } }
```

## Inspecting Version Distribution

Use the inspector to check what versions are in your queues before bumping `since`:

```ts
const status = await taskora.inspect().migrations("send-email")
console.log(status)
// {
//   version: 3, since: 1, migrations: 2,
//   queue: { oldest: 2, byVersion: { 2: 5, 3: 142 } },
//   delayed: { oldest: 3, byVersion: { 3: 8 } },
//   canBumpSince: 2  // safe to bump since to 2
// }
```

`canBumpSince` tells you the safe floor — the oldest version with jobs still in the queue.
