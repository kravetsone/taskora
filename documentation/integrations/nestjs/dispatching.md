# Dispatching

`@taskora/nestjs` offers three ways to get a dispatchable `BoundTask` into a service. They all end up calling the same `app.register(contract)` under the hood — the difference is how the DX feels at the call site.

## TL;DR

| Path | When to use | Type safety | Decorator |
|---|---|---|---|
| `TaskoraRef.for(contract)` | **Default** — 99% of producers | Full, zero annotations | `constructor(private tasks: TaskoraRef)` — no decorator |
| `@InjectTask(contract)` + `InferBoundTask` | Property-decorator fans | Full, via `InferBoundTask<typeof contract>` | Yes |
| `forFeature([contracts])` | You want explicit per-contract DI tokens | Full | Yes |

Use `TaskoraRef.for()` unless you have a concrete reason to reach for the others.

## `TaskoraRef.for()` — the primary path

`TaskoraRef` is a thin injectable service wrapping the App. It's auto-provided by `TaskoraModule.forRoot`, so every service can constructor-inject it without any module-side registration:

```ts
import { Injectable } from "@nestjs/common"
import { TaskoraRef } from "@taskora/nestjs"
import { sendEmailTask } from "@/tasks"

@Injectable()
export class EmailService {
  constructor(private readonly tasks: TaskoraRef) {}

  async notifySignup(user: User) {
    const handle = this.tasks.for(sendEmailTask).dispatch({
      to: user.email,
      subject: `Welcome, ${user.name}`,
    })
    const { messageId } = await handle.result
    return messageId
  }
}
```

### Why this is the default path

`.for()` is a generic method: `for<I, O>(contract: TaskContract<I, O>): BoundTask<I, O>`. TypeScript inference propagates the contract's input/output types all the way to `.dispatch()` and `handle.result`, with zero manual annotations. Rename a field in `sendEmailTask`'s schema and every call site updates automatically.

This is the DX you'd get from taskora directly with `taskora.register(contract)`, just wrapped in a DI-friendly service. Nothing is lost.

### `.for()` is cheap

`app.register(contract)` is idempotent — calling it twice returns the same `Task` instance under the hood via a `Map` lookup. You can call `this.tasks.for(contract)` inside every method, inside a getter, or cache it in a field — performance is the same.

```ts
@Injectable()
export class EmailService {
  constructor(private readonly tasks: TaskoraRef) {}

  // Style 1: inline — reads most naturally for one-off dispatches
  async sendOne(to: string) {
    await this.tasks.for(sendEmailTask).dispatch({ to, subject: "Hi" })
  }

  // Style 2: getter — handy if you reuse the bound task several times
  private get sendEmail() {
    return this.tasks.for(sendEmailTask)
  }

  async sendMany(recipients: string[]) {
    await Promise.all(
      recipients.map((to) => this.sendEmail.dispatch({ to, subject: "Hi" })),
    )
  }
}
```

### Accessing the raw `App`

If you need the full App (e.g. to query `app.schedules`, `app.deadLetters`, or attach app-level event listeners), reach for it via `TaskoraRef.raw`:

```ts
constructor(private readonly tasks: TaskoraRef) {}

someMethod() {
  this.tasks.raw.on("worker:ready", () => console.log("worker up"))
}
```

For more structured access use the dedicated `@InjectInspector` / `@InjectDeadLetters` / `@InjectSchedules` decorators — see [Observability](./observability).

## `@InjectTask` — the escape hatch

If you prefer property-style injection (one decorator per bound task in the constructor signature), you can opt into `@InjectTask` plus the `InferBoundTask` helper:

```ts
import { Injectable } from "@nestjs/common"
import { InjectTask, type InferBoundTask } from "@taskora/nestjs"
import { sendEmailTask } from "@/tasks"

@Injectable()
export class EmailService {
  constructor(
    @InjectTask(sendEmailTask)
    private readonly sendEmail: InferBoundTask<typeof sendEmailTask>,
  ) {}

  async notifySignup(user: User) {
    await this.sendEmail.dispatch({ to: user.email, subject: "Welcome" })
  }
}
```

### Why `InferBoundTask<typeof contract>` and not `BoundTask<I, O>`?

TypeScript parameter decorators can't propagate generics into the decorated property's type — there's no `@InjectTask<I, O>(contract)` that fills in the property type automatically. Without a helper you'd have to write:

```ts
// ❌ Manual duplication, drifts the moment the schema changes
@InjectTask(sendEmailTask)
private sendEmail: BoundTask<{ to: string; subject: string }, { messageId: string }>
```

`InferBoundTask<typeof contract>` is an alias for `BoundTask<InferInput<typeof contract>, InferOutput<typeof contract>>`, so it reads the types directly off the contract value. No duplication, no drift — rename a field in `sendEmailTask` and the type tracks.

### Requires `forFeature`

Unlike `TaskoraRef.for()`, `@InjectTask` needs the contract to be registered as a DI provider. Add `TaskoraModule.forFeature([...contracts])` to the feature module:

```ts
@Module({
  imports: [TaskoraModule.forFeature([sendEmailTask, processImageTask])],
  providers: [EmailService],
})
export class EmailModule {}
```

`forFeature` creates one factory provider per contract, keyed on `getTaskToken(contract)`. Importing it multiple times (in different feature modules) is safe — the factory calls `app.register(contract)` which is idempotent.

## `forFeature` without `@InjectTask`

You can import `forFeature` purely for the "explicit DI token" side effect if you want strict visibility of which contracts a module uses. But you don't need to — every `TaskoraRef.for(contract)` call works without it. `forFeature` is pure documentation unless you use `@InjectTask`.

## Multi-app dispatching

Pass the app name to both the `TaskoraRef` injection and the call:

```ts
import { Injectable } from "@nestjs/common"
import { InjectTaskoraRef, TaskoraRef } from "@taskora/nestjs"

@Injectable()
export class MultiTenantService {
  constructor(
    readonly primaryTasks: TaskoraRef,                          // default slot
    @InjectTaskoraRef("tenant-b") readonly tenantB: TaskoraRef, // named slot
  ) {}

  async queueForTenant(which: "a" | "b", task: Task, data: unknown) {
    const ref = which === "a" ? this.primaryTasks : this.tenantB
    return ref.for(task).dispatch(data)
  }
}
```

Registration side:

```ts
@Module({
  imports: [
    TaskoraModule.forRoot({ adapter: redisAdapter({ client: primary }) }),
    TaskoraModule.forRoot({ name: "tenant-b", adapter: redisAdapter({ client: tenantB }) }),
  ],
})
export class AppModule {}
```

The default slot (`TaskoraModule.forRoot` without `name`) is provided via the `TaskoraRef` class token so `constructor(private tasks: TaskoraRef)` still works without any decorator. Named slots use `@InjectTaskoraRef('name')`.

## `DispatchOptions` passthrough

Every `DispatchOptions` taskora supports works with `TaskoraRef.for(...).dispatch(data, options)`:

```ts
// Delayed dispatch
await tasks.for(sendEmailTask).dispatch(
  { to, subject: "Weekly digest" },
  { delay: "1h" },
)

// Debounced — only the latest wins within the window
await tasks.for(searchIndexTask).dispatch(
  { documentId: id },
  { debounce: { key: `idx:${id}`, delay: "5s" } },
)

// Deduplicated — skip if already queued
await tasks.for(processReceiptTask).dispatch(
  { receiptId },
  { deduplicate: { key: receiptId } },
)
```

See the main [Dispatching guide](/guide/dispatching) for the full list of flow-control options.

## Awaiting results

`.dispatch()` returns a `ResultHandle<TOutput>` synchronously. It's thenable (resolves to the job ID), and has `.result` for push-based result resolution:

```ts
const handle = tasks.for(processImageTask).dispatch({ url })

const jobId = await handle           // "uuid-..." — just the ID
const result = await handle.result    // { width, height, format }
const state = await handle.getState() // "waiting" | "active" | "completed" | ...
```

Awaiting results only works when the worker for that contract is actually running — either in the same process (monolith) or a sibling worker process (split deploy) subscribed to the same Redis. See [Deployment](./deployment) for the monolith vs split setup.
