# Splitting Producer & Worker

Sometimes you need the producer (API server, cron service, webhook receiver) and the worker (background jobs) to run in separate processes. When that happens, both sides need to agree on task names and data shapes — this page shows two low-friction ways to share [task contracts](/guide/contracts) between them.

::: tip Default: keep it monolithic
For most projects, running producer and worker in the same process is simpler and works fine — `taskora.task("name", { handler })` covers everything. Only reach for the split when you have a concrete reason:

- The worker has heavy dependencies (`sharp`, `puppeteer`, `ffmpeg`, native bindings) that you don't want in the API server bundle.
- The two sides have genuinely different scaling/deploy characteristics (API auto-scales on HTTP traffic, worker scales on queue depth).
- The producer runs on an edge runtime or browser that can't execute the handler's runtime at all.

If none of those apply, stay monolithic. You can always split later — the contract layer is backwards-compatible with inline tasks.
:::

## The question is not "should you use contracts" — it's "where do the contracts live"

Whichever strategy you pick, the code-level pattern is the same:

```ts
// Shared — defined once
export const sendEmailTask = defineTask({
  name: "send-email",
  input: z.object({ to: z.string().email(), subject: z.string() }),
  output: z.object({ messageId: z.string() }),
})

// Producer — no handler imports
const sendEmail = taskora.register(sendEmailTask)
await sendEmail.dispatch({ to: "alice@example.com", subject: "Welcome" })

// Worker — the heavy-deps side
taskora.implement(sendEmailTask, async (data, ctx) => {
  return { messageId: await mailer.send(data) }
})
```

The only question is where `sendEmailTask` physically lives so both sides can import it.

## Strategy 1: Single package, two entrypoints

**Recommended default** for small-to-mid teams, startups, and any project that doesn't already have workspace tooling. One `package.json`, one install, two `bin` entrypoints.

```
my-app/
├── package.json
├── src/
│   ├── contracts/
│   │   └── tasks.ts          ← defineTask() declarations live here
│   ├── api/
│   │   └── index.ts          ← imports contracts/tasks, dispatches
│   └── worker/
│       └── index.ts          ← imports contracts/tasks, implements
└── Dockerfile                ← one image, different CMD per container
```

```ts
// src/contracts/tasks.ts
import { defineTask } from "taskora"
import { z } from "zod"

export const sendEmailTask = defineTask({
  name: "send-email",
  input: z.object({ to: z.string().email(), subject: z.string() }),
  output: z.object({ messageId: z.string() }),
})
```

```ts
// src/api/index.ts — producer
import { createTaskora } from "taskora"
import { redisAdapter } from "taskora/redis"
import { sendEmailTask } from "../contracts/tasks.js"

const taskora = createTaskora({ adapter: redisAdapter(process.env.REDIS_URL!) })
const sendEmail = taskora.register(sendEmailTask)

// Express / Hono / Fastify — whatever your HTTP stack is
app.post("/signup", async (req, res) => {
  await sendEmail.dispatch({
    to: req.body.email,
    subject: "Welcome",
  })
  res.json({ ok: true })
})
```

```ts
// src/worker/index.ts — worker
import { createTaskora } from "taskora"
import { redisAdapter } from "taskora/redis"
import { sendEmailTask } from "../contracts/tasks.js"
import { mailer } from "./mailer.js"

const taskora = createTaskora({ adapter: redisAdapter(process.env.REDIS_URL!) })

taskora.implement(sendEmailTask, async (data, ctx) => {
  return { messageId: await mailer.send(data) }
})

await taskora.start()
```

Build with `pkgroll` / `tsup` using two entries (`src/api/index.ts` and `src/worker/index.ts`). Tree-shaking guarantees the producer bundle never pulls in `./mailer.js` or its transitive deps — the contract file just re-exports a plain object.

Deploy as two containers from the same image:

```dockerfile
FROM node:24-alpine
WORKDIR /app
COPY . .
RUN npm ci && npm run build
# Container command set at deploy time
CMD ["node", "dist/api/index.js"]
```

```yaml
# docker-compose.yml
services:
  api:
    build: .
    command: node dist/api/index.js
  worker:
    build: .
    command: node dist/worker/index.js
```

**Friction: 1/5.** Zero workspace tooling, no publish step, standard TypeScript project layout. This is the default recommendation and fits ~80% of cases.

## Strategy 2: Monorepo with workspaces

Once your team grows and you have multiple apps sharing contracts, promote them to a workspace package. Bun and pnpm workspaces use the `workspace:*` protocol — no publish step, no private registry, the workspace tool symlinks the package locally.

```
my-monorepo/
├── package.json              (workspaces: ["packages/*", "apps/*"])
├── packages/
│   └── contracts/
│       ├── package.json
│       └── src/
│           ├── index.ts
│           └── tasks.ts      ← defineTask() declarations
├── apps/
│   ├── api/
│   │   ├── package.json      ("@acme/contracts": "workspace:*")
│   │   └── src/server.ts
│   ├── worker/
│   │   ├── package.json      ("@acme/contracts": "workspace:*")
│   │   └── src/main.ts
│   └── webhook-receiver/
│       ├── package.json      ("@acme/contracts": "workspace:*")
│       └── src/handler.ts
└── bun.lockb
```

Minimal `packages/contracts/package.json`:

```json
{
  "name": "@acme/contracts",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "peerDependencies": {
    "taskora": "*",
    "zod": "*"
  }
}
```

Consumer `apps/api/package.json`:

```json
{
  "name": "@acme/api",
  "type": "module",
  "dependencies": {
    "@acme/contracts": "workspace:*",
    "taskora": "^0.3.0",
    "zod": "^4.0.0"
  }
}
```

```ts
// apps/api/src/server.ts
import { sendEmailTask } from "@acme/contracts"

const sendEmail = taskora.register(sendEmailTask)
await sendEmail.dispatch({ to: "alice@example.com", subject: "Welcome" })
```

`workspace:*` is a **native protocol** of bun/pnpm/yarn — `bun install` and `pnpm install` symlink the package locally. Nothing gets published to npm unless you explicitly do it. This is not "enterprise tooling" — it's the standard TypeScript monorepo layout in 2026.

**Friction: 2/5 initial, 1/5 ongoing.** Use this when you have three or more consumers of the same contracts (e.g. web API + background worker + webhook receiver all dispatching to the same worker pool).

## What NOT to do

A few approaches that look tempting but hurt in practice:

- **Relative imports across service directories** — `apps/api/src/server.ts` doing `import from "../../worker/src/tasks.js"` works short-term but turns into a rat's nest the moment you move a directory. Use workspaces instead.
- **TypeScript path aliases without workspaces** — `paths: { "@contracts/*": ["../contracts/*"] }` is a compile-time convenience but doesn't resolve at runtime. You'll hit "works in dev, breaks in prod" bugs. Use workspaces.
- **Private npm registry for contract packages** — GitHub Packages / Verdaccio / npm Pro. Overkill unless you're publishing to teams outside your own codebase. For internal sharing, `workspace:*` does the same thing without the infrastructure.
- **Copy-paste the contract file into each repo** — drifts silently, doesn't compose, and the inevitable "production is dispatching v2 but staging worker expects v1" bug is painful to debug. Use a workspace.
- **Code generation from protobuf / OpenAPI** — heavy, loses the ergonomics of Standard Schema inference, and taskora already gives you type inference from Zod/Valibot/ArkType directly. Skip it.

## Runtime safety net — independent of sharing strategy

Regardless of how contracts are physically shared, taskora gives you two runtime guarantees against drift:

1. **Worker-side schema validation.** Workers always validate job data through the task's Standard Schema before calling the handler. If a producer is on an older version of the contract and dispatches data the worker can't parse, the job fails with a clear `ValidationError` — the handler never sees malformed data.

2. **Payload versioning & migrations.** taskora's [version / migrate](/features/versioning) system lets contracts evolve without requiring producer and worker deploys to happen atomically. Ship worker first with migrations for older payloads, then ship producer with the new shape — in-flight jobs drain correctly.

These two mechanisms mean the distribution strategy you pick above is about developer ergonomics, not correctness. Pick the cheapest option that covers your team size.

## Summary

| Team shape | Strategy |
|---|---|
| 1–5 devs, one codebase, API + worker | **Strategy 1** — single package, two entrypoints |
| 5+ devs, multiple apps, shared contracts | **Strategy 2** — monorepo + `workspace:*` |
| Fully separate repos, different teams | Strategy 2 with git submodules (painful, consider merging first) |
| Polyglot (TypeScript producer, Python worker) | Out of scope — taskora is TypeScript-first on both sides |

Both strategies compose with [contracts](/guide/contracts) identically. Start with Strategy 1 and promote to Strategy 2 when the second consumer shows up.
