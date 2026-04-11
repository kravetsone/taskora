# Admin Dashboard

`@taskora/board` is the pre-built React SPA + Hono API that taskora ships as a separate package. `@taskora/nestjs` exposes it as an injectable provider via `TaskoraBoardModule`, with the actual HTTP mounting left to `main.ts` — because the board is a Hono app, not an Express or Fastify router, and Nest's platform adapters don't speak Hono natively.

## Installation

The board is an **optional** peer dependency. Install it only when you want the dashboard:

::: pm-add @taskora/board hono @hono/node-server
:::

- `@taskora/board` — the board itself (Hono backend + compiled SPA)
- `hono` — peer dep of `@taskora/board`
- `@hono/node-server` — bridge that turns `board.fetch` into a Node http listener Nest can mount

If you skip `TaskoraBoardModule.forRoot` entirely, none of these packages are loaded — the module uses a dynamic `import("@taskora/board")` inside an async factory, so consumers who don't use the board pay zero bundle or startup cost.

## Registering the module

```ts
// src/app.module.ts
import { Module } from "@nestjs/common"
import { TaskoraBoardModule, TaskoraModule } from "@taskora/nestjs"
import { redisAdapter } from "taskora/redis"
import { Redis } from "ioredis"

@Module({
  imports: [
    TaskoraModule.forRoot({
      adapter: redisAdapter({ client: new Redis(process.env.REDIS_URL!) }),
    }),
    TaskoraBoardModule.forRoot({
      basePath: "/board",
      readOnly: false,
      auth: {
        cookiePassword: process.env.BOARD_COOKIE_PASSWORD!,
        authenticate: async ({ username, password }) => {
          // Return a user object on success, null on failure.
          if (username === "admin" && password === process.env.BOARD_PASSWORD) {
            return { username: "admin", role: "admin" }
          }
          return null
        },
      },
    }),
  ],
})
export class AppModule {}
```

Every option except `name` and `board` passes straight through to `@taskora/board`'s `createBoard(app, options)`. See the [Board operations guide](/operations/board) for the full `BoardOptions` shape — `title`, `logo`, `favicon`, `redact`, `theme`, `refreshInterval`, `cors`, `formatters`, etc.

## Mounting in `main.ts`

The module provides the `Board` instance under `getBoardToken()`, but it's up to `main.ts` to attach that instance to the HTTP server. Three lines for Express:

```ts
// src/main.ts
import "reflect-metadata"
import { NestFactory } from "@nestjs/core"
import { getRequestListener } from "@hono/node-server"
import type { Board } from "@taskora/board"
import { getBoardToken } from "@taskora/nestjs"
import { AppModule } from "./app.module"

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.enableShutdownHooks()

  // Pull the Board out of the DI graph and mount it.
  const board = app.get<Board>(getBoardToken())
  app.use("/board", getRequestListener(board.fetch))

  await app.listen(3000)
}
bootstrap()
```

That's it. Open `http://localhost:3000/board/` and you get the full SPA — overview, per-task job tables, job detail with logs/progress/timeline, workflow DAG viewer, schedules, DLQ, migrations, throughput charts, live SSE updates.

### Fastify

Swap `NestFactory.create` for the Fastify adapter and use Fastify's raw-request fall-through:

```ts
import { NestFactory } from "@nestjs/core"
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify"
import { getRequestListener } from "@hono/node-server"
import type { Board } from "@taskora/board"
import { getBoardToken } from "@taskora/nestjs"

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  )

  const board = app.get<Board>(getBoardToken())
  const listener = getRequestListener(board.fetch)

  // Fastify raw handler fall-through for the /board prefix.
  app.getHttpAdapter().getInstance().all("/board/*", (req, reply) => {
    listener(req.raw, reply.raw)
  })

  await app.listen(3000)
}
```

### Bun's native HTTP

If you're running Nest on Bun (via `@nestjs/platform-express` or a Bun-native adapter), you can skip `@hono/node-server` entirely and call `board.fetch` directly:

```ts
const board = app.get<Board>(getBoardToken())
Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.startsWith("/board")) return board.fetch(req)
    return app.getHttpAdapter().getInstance()(req)
  },
})
```

## Using the Board from services

You can inject the Board into any provider via `@InjectBoard()` — useful if you want to read its state from a custom admin endpoint, or register listeners on its underlying Hono app:

```ts
import { Injectable } from "@nestjs/common"
import { InjectBoard } from "@taskora/nestjs"
import type { Board } from "@taskora/board"

@Injectable()
export class BoardIntegrationService {
  constructor(@InjectBoard() private readonly board: Board) {}

  // Add a custom Hono route alongside the board's own routes.
  registerExtraRoute() {
    this.board.app.get("/extra", (c) => c.json({ ok: true }))
  }
}
```

`Board` is imported from `@taskora/board`, not from `@taskora/nestjs` — we deliberately don't re-export the type to keep `@taskora/nestjs`'s own type graph independent of the optional peer dep.

## Multi-app / multi-board

Each `TaskoraBoardModule.forRoot` call is bound to a specific named app via the `name` option. You can mount two separate boards for two different taskora apps:

```ts
@Module({
  imports: [
    TaskoraModule.forRoot({ adapter: primaryAdapter }),
    TaskoraModule.forRoot({ name: "background", adapter: backgroundAdapter }),

    TaskoraBoardModule.forRoot({ basePath: "/board" }),
    TaskoraBoardModule.forRoot({ name: "background", basePath: "/board-bg" }),
  ],
})
export class AppModule {}
```

```ts
// main.ts
const primaryBoard = app.get<Board>(getBoardToken())
const bgBoard = app.get<Board>(getBoardToken("background"))

app.use("/board", getRequestListener(primaryBoard.fetch))
app.use("/board-bg", getRequestListener(bgBoard.fetch))
```

Each board shows only jobs from its own app. They don't share state, auth, or UI — they're fully isolated.

## Auth patterns

The board supports two auth modes:

### Built-in cookie auth

Pass a `BoardAuthConfig` object to `auth`:

```ts
TaskoraBoardModule.forRoot({
  basePath: "/board",
  auth: {
    cookiePassword: process.env.BOARD_COOKIE_PASSWORD!, // 32+ chars
    authenticate: async ({ username, password }) => {
      // Validate however you want — call out to your UserService, check
      // a password hash, etc. Return a user object (shape is yours to
      // define; ends up in the signed cookie) or null.
      return await this.validateAdmin(username, password)
    },
    // Optional:
    loginPath: "/login",     // where unauthenticated GETs redirect to
    logoutPath: "/logout",   // GET clears the cookie
    sessionTTL: 60 * 60,     // seconds; default 2h
  },
})
```

The board renders its own login page at `/board/login` and sets an encrypted cookie on success. You don't write any HTML.

`cookiePassword` **must** be ≥ 32 characters — taskora throws at createBoard time if it's shorter. Use `openssl rand -hex 32` or a secrets manager.

### Legacy callback auth

If you have an existing auth story and just want a guard fn:

```ts
TaskoraBoardModule.forRoot({
  basePath: "/board",
  auth: async (req) => {
    // Return truthy → allow, falsy → 401
    return req.headers["x-admin-token"] === process.env.ADMIN_TOKEN
  },
})
```

This path skips the login page entirely — the board assumes auth was handled upstream (e.g. by a reverse proxy or a Nest guard on a parent route). Useful when your API gateway already enforces admin auth.

### `readOnly: true`

Regardless of auth mode, set `readOnly: true` in staging environments to block every mutating action (retry, cancel, trim, DLQ retry-all) while still allowing inspection:

```ts
TaskoraBoardModule.forRoot({
  basePath: "/board",
  readOnly: process.env.NODE_ENV !== "production",
  auth: { /* ... */ },
})
```

## Environment checklist

Before production:

- **`BOARD_COOKIE_PASSWORD`** set to 32+ chars (use `crypto.randomBytes(32).toString("hex")` to generate).
- **`auth`** configured — never ship a board without auth on a public endpoint.
- **`readOnly: true`** in non-prod if you want inspectors to browse without bricking anything.
- **Reverse proxy** (nginx/cloudflare) with HTTPS enforcement — board sets `Secure` cookies only over HTTPS.
- **`redact: ['password', 'token', 'secret', 'apiKey']`** (or your own keys) so PII in job payloads doesn't leak into the UI.

See the full [Board operations guide](/operations/board) for production hardening — CORS, reverse proxy headers, session management, CSP.
