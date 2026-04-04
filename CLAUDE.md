# taskora

Task queue library for Node.js. TypeScript-first, Celery-inspired, BullMQ replacement.

## Project overview

- **Package name**: `taskora` (npm available)
- **Repo**: Resetting the `jobify` repo — new library from scratch
- **Design docs**: `docs/API_DESIGN.md` (API surface), `docs/IMPLEMENTATION.md` (phases, Redis layout, Lua scripts)

## Tech stack

- **Language**: TypeScript 5.x (strict mode)
- **Module system**: ESM-first (`"type": "module"`) with CJS build output
- **tsconfig**: `module: "NodeNext"`, `moduleResolution: "NodeNext"` — use `.js` extensions in imports
- **Build**: pkgroll (multi-entrypoint: `.`, `./redis`, future `./postgres`)
- **Lint/format**: Biome — 2 spaces, double quotes, organize imports, `noExplicitAny: off`
- **Test framework**: Vitest (pool: forks, singleFork: true)
- **Test infra**: `@testcontainers/redis` — no docker-compose, no local Redis needed
- **Package manager**: Bun
- **CI**: GitHub Actions — ubuntu-latest, setup-bun + setup-node, Docker (testcontainers auto-pulls redis:7-alpine)
- **Redis client**: ioredis (peer dep of `taskora/redis`)
- **Redis version**: 7.0+
- **Schema validation**: `@standard-schema/spec` (peer dep, types only)

## Package structure

```
taskora              — core engine, types, task API (zero DB deps)
taskora/redis        — Redis adapter (peer dep: ioredis)
taskora/postgres     — future
taskora/test         — in-memory runner (future)
taskora/telemetry    — OpenTelemetry adapter (future)
taskora/react        — React hooks (future)
```

`ioredis` is an optional peer dep — only required when using `taskora/redis`.

## Source layout

```
src/
├── index.ts              — public API: taskora() factory, re-exports
├── app.ts                — App class
├── task.ts               — Task class
├── worker.ts             — Worker loop
├── context.ts            — Taskora.Context (ctx in handlers)
├── result.ts             — ResultHandle (thenable)
├── schema.ts             — Standard Schema integration
├── serializer.ts         — Serializer interface + json() default
├── types.ts              — Taskora namespace (all public types)
├── errors.ts             — Error classes
├── redis/
│   ├── index.ts          — redisAdapter() factory
│   ├── backend.ts        — Adapter implementation
│   └── lua/              — Lua scripts
└── ...
```

## Conventions

- All public types live under the `Taskora` namespace — `import type { Taskora } from "taskora"`
- Adapter interface is the abstraction boundary — core never imports ioredis/pg directly
- Every multi-step Redis state transition MUST be a Lua script (atomicity)
- Split storage: job metadata hash (ziplist) + separate `:data` and `:result` string keys
- All keys for one job share a `{hash tag}` for Redis Cluster compatibility

## Commands

```bash
bun install              # install deps
bun run build            # pkgroll build
bun test                 # vitest (needs Docker for integration tests)
bun run lint             # biome check
bun run format           # biome format --write
```

## Implementation phases

Currently on **Phase 1: Core Engine (MVP)** — completed. See `docs/IMPLEMENTATION.md` for full phase breakdown. Next: **Phase 2: Schema Validation + Type Inference**.

Phase 1 delivered:
- Expanded `Taskora.Adapter` interface (8 methods: enqueue, dequeue, ack, fail, nack, extendLock, connect, disconnect)
- 7 atomic Lua scripts with split storage + XADD events (enqueue, enqueueDelayed, dequeue, ack, fail, nack, extendLock)
- Redis backend: SCRIPT LOAD/EVALSHA with NOSCRIPT fallback, lazyConnect, {hash tag} Cluster compat
- `Taskora.Serializer` interface + `json()` default
- `Task<TInput, TOutput>` class with `dispatch()` / `dispatchMany()`
- `Worker`: exponential backoff polling (50ms→1s), concurrency control, lock extension (30s/10s), graceful shutdown with AbortSignal
- `App`: task registry, `start()` / `close()`, auto-connect on first dispatch
- Property name: `adapter` (not `backend`) — consistent with `Taskora.Adapter` / `redisAdapter()`
- Key prefix optional, omitted by default: `taskora:{task}:key`
- 13 integration tests (lifecycle, delayed, concurrency, shutdown, bulk, connection modes)
