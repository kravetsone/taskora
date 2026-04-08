# Cross-Runtime CI

[![Test](https://github.com/kravetsone/taskora/actions/workflows/test.yml/badge.svg)](https://github.com/kravetsone/taskora/actions/workflows/test.yml)

Taskora officially supports **three JavaScript runtimes** (Node.js, Bun, Deno) and **two Redis client implementations** (ioredis and Bun's native `Bun.RedisClient`). Every commit and every pull request runs the complete integration suite against every valid combination — in parallel on GitHub Actions — before any code can land, and again before any version can ship.

<TestingMatrix />

This page documents what is tested, how, and why the matrix exists.

## The matrix

Four cells, all mandatory, all gating merges and releases:

| # | Runtime | Driver entry point | Purpose |
|---|---|---|---|
| 1 | **Node 20** | `taskora/redis` → `taskora/redis/ioredis` | Golden baseline. Node LTS is the reference platform most users will run. |
| 2 | **Bun 1.3+** | `taskora/redis` → `taskora/redis/ioredis` | Proves ioredis works under Bun's Node-compatibility layer. Use this if you are already running Bun and have other ioredis-using code in your project. |
| 3 | **Bun 1.3+** | `taskora/redis/bun` → native `Bun.RedisClient` | Zero-peer-dependency path for Bun-only deployments. Goes straight through Bun's built-in Redis client and drops the ioredis peer dep entirely. |
| 4 | **Deno 2.x** | `taskora/redis` → `taskora/redis/ioredis` | ioredis imported via Deno's `npm:` specifier and `--node-modules-dir=auto`. Lets you use Taskora from Deno projects without maintaining a separate Deno-native Redis adapter. |

Not on the matrix: **Deno + `Bun.RedisClient`**. Bun's native Redis client is a Bun-runtime global — it is unavailable under Deno by definition.

## What runs

Every cell executes **the same ~300-test integration suite** against a real Redis container. The suite exercises every production code path the library offers:

- **Lua scripts** — all 30+ atomic server-side scripts (enqueue, dequeue, ack, fail, nack, retry, stall detection, delayed promotion, cancel, cancel-finish, workflow advance, workflow fail, DLQ retry, DLQ retry-all, DLQ trim, completed trim, version distribution, debounce, throttle, dedup, collect, scheduler tick, leader lock acquire, leader lock renew, clean jobs, list job details).
- **Blocking dequeue** — `BZPOPMIN`-driven poll loop with marker sorted sets for instant wake on new work.
- **Stream events** — `XADD` producer, `XREAD BLOCK` consumer, per-event enrichment via `HMGET`.
- **Pub/sub cancellation** — `cancel.lua` → `PUBLISH` → worker's subscribe handler → `AbortController.abort("cancelled")` → `onCancel` hook cleanup.
- **Distributed leader election** — `SET NX PX` token-based leader for the scheduler across multiple app instances.
- **Workflow DAG execution** — `chain`, `group`, `chord`, nested compositions, cascade cancellation, terminal-node aggregation.
- **Flow control** — debounce (replace delayed job), throttle (rate-limited enqueue via atomic Lua), deduplicate (skip if existing in matching state), collect (batch accumulator with three flush triggers).
- **Retention and DLQ** — automatic trim of old completed / failed jobs with age + count policies, single-job retry, bulk retry-all.
- **Schema validation** — Standard Schema spec, post-migration validation, default-value application.
- **Schedulers** — interval and cron, overlap prevention, missed-run catch-up policies, pause / resume / trigger / remove / update runtime management.
- **Migrations** — tuple and record migrate forms, version gating (future nack, past fail), inspector version distribution.
- **Multi-instance coordination** — work distribution, stall recovery between pods, cross-pod cancellation.

Per-matrix-cell wall-clock is around 50–80 seconds. The whole matrix completes in under two minutes of real time because the cells run in parallel.

## How each runtime is invoked

The test runner is **Vitest** on every cell — one test harness, one config, one report format. Only the entry point differs:

::: code-group
```bash [Node]
npx vitest run
```

```bash [Bun + ioredis]
bunx --bun vitest run
```

```bash [Bun + BunDriver]
TASKORA_TEST_DRIVER=bun bunx --bun vitest run
```

```bash [Deno]
deno run -A --node-modules-dir=auto npm:vitest/vitest.mjs run
```
:::

Two details matter:

1. **`bunx --bun` is load-bearing.** Plain `bunx` follows the vitest binary's shebang and routes through Node — which silently ran the test suite under Node even in workflows that looked like they were testing Bun. Only `bunx --bun` forces execution under the Bun runtime.
2. **`TASKORA_TEST_DRIVER=bun` is the switch** between `taskora/redis/ioredis` and `taskora/redis/bun`. Internally the test suite imports from a thin shim (`tests/create-adapter.ts`) that picks the real factory at module load based on this env var. Test files themselves are runtime-agnostic.

## Redis provisioning

CI uses a GitHub Actions `services: redis:7-alpine` sidecar and sets `REDIS_URL=redis://localhost:6379` for every cell. The test `globalSetup` honors a pre-existing `REDIS_URL` and skips its own testcontainers spin-up — so there is no Docker-in-Docker, no test-container lifecycle management per cell, and all four runtimes talk to the same shared Redis instance.

Locally, if you already have Redis running on `localhost:6379` the same skip applies: tests will use it instead of spawning a new container. If you do not, the `@testcontainers/redis` package will automatically pull `redis:7-alpine` and start a fresh container for you.

## How it is wired into the workflow

The workflow file is [`.github/workflows/test.yml`](https://github.com/kravetsone/taskora/blob/main/.github/workflows/test.yml) in the repo. Shape:

```yaml
name: Test

on:
  push:                          # every branch, every push
  pull_request:
    branches: [main]             # external fork PRs
  workflow_call:                 # reused by publish.yml

jobs:
  lint-build:
    # Biome + pkgroll, once, on Node 20 — runtime-agnostic.

  test:
    strategy:
      fail-fast: false           # never hide divergence by cancelling peers
      matrix:
        include:
          - { runtime: node, driver: ioredis }
          - { runtime: bun,  driver: ioredis }
          - { runtime: bun,  driver: bun }
          - { runtime: deno, driver: ioredis }
    services:
      redis:                     # shared sidecar for every cell
        image: redis:7-alpine
    env:
      REDIS_URL: redis://localhost:6379
      TASKORA_TEST_DRIVER: ${{ matrix.driver }}
    steps:
      # ...runtime-specific vitest invocation...
```

And the publish workflow calls it:

```yaml
# .github/workflows/publish.yml
jobs:
  tests:
    uses: ./.github/workflows/test.yml   # reusable-workflow call

  publish_package:
    needs: tests                          # gated on every matrix cell green
    # ...jsr publish, npm publish, GitHub release...
```

If any matrix cell is red, `publish_package` simply does not run. **A release cannot ship with any supported runtime × driver combination broken.**

## Running the matrix locally

Every cell is reproducible on your machine. Start a Redis on `localhost:6399` (the tests honor the pre-set `REDIS_URL` and skip their own testcontainer), then:

```bash
# Redis sidecar for the session
docker run --rm -d --name taskora-test-redis -p 6399:6379 redis:7-alpine
export REDIS_URL=redis://localhost:6399

# Matrix cells
bun run test:node          # Node   + ioredis
bun run test:bun:ioredis   # Bun    + ioredis  (bunx --bun vitest run)
bun run test:bun           # Bun    + Bun.RedisClient  (TASKORA_TEST_DRIVER=bun)
bun run test:deno          # Deno   + ioredis  (npm: specifier via --node-modules-dir=auto)

# Or all four, one after the other
bun run test:all
```

All four scripts live in `package.json` and correspond exactly to what CI runs. Cleanup when done:

```bash
docker stop taskora-test-redis
```

## Writing your own tests

If you are looking for the library's **user-facing** test utilities — the in-memory adapter, virtual time, the `runner.run()` / `runner.execute()` helpers that let you test your handlers without Redis or Docker — that is covered in [Testing → Overview](/testing/). The cross-runtime CI documented on this page is about how Taskora itself is tested, not about how your application should test its tasks.
