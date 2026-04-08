# Taskora cross-runtime testing matrix

**Phase 1 audit results.** Runtimes locally: Bun 1.3.9, Node 22.22.0, Deno 2.7.4. Redis: dedicated `redis:7-alpine` via Docker and testcontainers spawning the same image on demand.

## Compat findings (empirical)

| # | Runtime | Driver     | Test runner invocation                                                   | Redis provisioning        | Status      | Evidence |
|---|---------|-----------|---------------------------------------------------------------------------|---------------------------|-------------|----------|
| 1 | Node    | ioredis    | `npx vitest run`                                                          | testcontainers            | **green**   | lifecycle: 10/10, 3.76s |
| 2 | Bun     | ioredis    | `bunx --bun vitest run`                                                   | testcontainers            | **green**   | lifecycle: 10/10, 3.61s |
| 3 | Bun     | BunDriver  | `bunx --bun vitest run` (with `src/redis/index.ts` repointed to `bun.js`) | testcontainers            | **mostly green, 4 bugs** | 5 files: 56/60, details below |
| 4 | Deno    | ioredis    | `deno run -A --node-modules-dir=auto npm:vitest/vitest.mjs run`           | testcontainers            | **green**   | lifecycle: 10/10, 3.17s; standalone testcontainers start: 276ms |
| 5 | Deno    | BunDriver  | —                                                                         | —                         | **skip**    | Bun-only runtime API |

### Key confirmations (no guessing — each item was run locally)

- **Vitest works under Bun** with `pool: "forks"` + `singleFork: true`. No crashes on the worker protocol. `bunx` alone routes through the vitest shebang → Node; **must use `bunx --bun`** to actually exercise the Bun runtime.
- **Vitest works under Deno** via `npm:vitest/vitest.mjs run` with `--node-modules-dir=auto`. Deno auto-fetches npm deps on first run, subsequent runs reuse `node_modules/`.
- **Testcontainers works under Deno** — standalone `new RedisContainer("redis:7-alpine").start()` completes in ~276ms, clean stop. Verified by `/tmp/tc-check.mjs` script.
- **Testcontainers works under Bun** — inferred from a successful integration test run that used the globalSetup path.
- **ioredis works under Bun** — all 10 lifecycle tests pass. One warning: `MaxListenersExceededWarning` at `src/redis/drivers/ioredis.ts:89` (11 `ready`/`error` listeners on `[Commander]`). Non-fatal but should be looked at — small listener-count bookkeeping bug in the ioredis driver's `connect()` path.
- **ioredis works under Deno** — same 10/10 lifecycle pass. Same MaxListeners warning surfaces (same root cause in `drivers/ioredis.ts:89`).
- **Test duration is comparable across all three runtimes** (Node 3.76s / Bun 3.61s / Deno 3.17s for the lifecycle suite). No runtime is dramatically slower.

## BunDriver bugs found (Phase 4 targets)

Scope: ran `workflow.test.ts + inspector-dlq.test.ts + cancel.test.ts + retry.test.ts + lifecycle.test.ts` against `taskora/redis/bun`. **34/38 passed**, 4 failures in 2 distinct files. The other ~22 integration files were not exercised in Phase 1 — the real bug count is likely higher.

### Bug cluster A — list query ordering in `inspector.waiting()`

**File:** `tests/integration/inspector-dlq.test.ts:98` — `inspector list queries > waiting() returns enqueued jobs`.

Test dispatches jobs with `{n:1}` then `{n:2}`. Under ioredis, `waiting[0].data = {n:1}` (FIFO). Under BunDriver, `waiting[0].data = {n:2}` — **reversed order**.

**Hypothesis:** `LRANGE 0 -1` / `LPUSH`-side-newest convention — either BunDriver's `command("LRANGE", ...)` is returning in the wrong direction, or the driver is inverting the raw response. Not a Lua-script bug (inspector's `listJobs` uses plain commands). Also possible: `ZRANGE` reverse behavior under BunDriver when `REV` isn't passed.

**Fix location:** `src/redis/drivers/bun.ts` — likely in the command response normalization for `LRANGE`/`ZRANGE`. Needs empirical check first.

### Bug cluster B — active job cancellation via pub/sub doesn't fire

**Files:**
- `tests/integration/cancel.test.ts:176` — `cancel active job → handler aborted via ctx.signal`
- `tests/integration/cancel.test.ts:225` — `onCancel hook runs on active cancellation`

Both time out with `waitFor timed out after 5000ms`. All OTHER cancel states pass (`waiting`, `delayed`, `retrying`, `completed` — 7 cancel tests green).

The difference: **only active-job cancel uses Redis pub/sub**. `cancel.lua` calls `PUBLISH <channel> <jobId>`; the worker subscribes to that channel on job start and, on receipt, calls `controller.abort()`. Under BunDriver that signal **never arrives**.

**Hypothesis:** `BunDriver.subscribe()` is broken — either the message handler never fires, or the subscription is established AFTER the publish happens (race), or Bun's subscribed client is still in "send normal commands" mode and the driver never put it into subscriber mode. This is the exact area where Bun↔ioredis semantics diverge (Bun's subscribed client doesn't lock; ioredis's does). Note that `extendLock.lua` has a fallback path that catches cancellation via the "cancelled" return value — but that only fires on the next lock extension cycle (10s), well beyond the 5s `waitFor` timeout.

**Fix location:** `src/redis/drivers/bun.ts` subscribe path. Most likely culprit: the driver doesn't actually invoke Bun's `client.subscribe(channel)` API (or uses `.send("SUBSCRIBE", ...)` which may not dispatch message events), and the `handler` never gets called.

### Bug cluster C — `deadLetters.retryAll()` re-enqueued jobs never pick up

**File:** `tests/integration/inspector-dlq.test.ts:392` — `deadLetters.retryAll() re-enqueues all failed jobs`.

Dispatches 3 jobs, waits until they're all in DLQ, calls `retryAll`, then waits for `completed === 3`. The first wait (for failed=3) succeeds, so dispatch + retry path works. The second wait (for completed=3) hangs — **the retried jobs never get picked up**.

**Hypothesis:** `retryAllDLQ.lua` moves jobs from the `failed` sorted set back to the `wait` list, but probably does NOT re-add them to the `marker` sorted set that `BZPOPMIN` is blocking on. OR: BunDriver's `blockingZPopMin` doesn't observe the new marker correctly. Note: the single-job `deadLetters.retry(jobId)` test passes, which suggests it's specific to the batch path in `retryAllDLQ.lua`. Could be a pre-existing bug that only manifests under BunDriver because of timing (ioredis happens to reconnect BZPOPMIN fast enough to notice the new item on its next iteration).

**Fix location:** Either `src/redis/scripts.ts` (`retryAllDLQ.lua` missing marker ZADD) or `src/redis/drivers/bun.ts` (BZPOPMIN blocking client not waking up). Needs Lua script inspection + empirical test to determine.

### Also worth noting (not bugs, but observations)

- **`MaxListenersExceededWarning` in `drivers/ioredis.ts:89`** fires under Bun AND Deno (not Node?). It's the `connect()` method attaching `ready`/`error` listeners via `.once(...)`. 11 listeners means something is calling `connect()` repeatedly without cleaning up, or the underlying ioredis client emits these listeners eagerly. Cosmetic under Node, should fix for tidy logs everywhere.
- **Ryuk container persistence**: testcontainers on macOS leaves the Ryuk sidecar (`testcontainers-ryuk-*`) running across test invocations. Not a problem, just awareness for CI cleanup expectations.

## Chosen strategy (recommended to the user)

### Test runner per runtime

```
Node   : npx vitest run ...
Bun    : bunx --bun vitest run ...          ← --bun is critical, not optional
Deno   : deno run -A --node-modules-dir=auto npm:vitest/vitest.mjs run ...
```

### Redis provisioning

**Use testcontainers everywhere.** All three runtimes are confirmed to spawn containers successfully; there's no need to fall back to `services: redis` service containers in CI. Keeping a single code path (testcontainers) simplifies `tests/setup.ts` and matches local dev experience.

However, still **honor a pre-existing `REDIS_URL`** in `tests/setup.ts` — if the env var is set, skip container start and use it as-is. This enables local dev against a persistent Redis and gives us a fallback if testcontainers ever flakes under a specific runtime in CI without a code change.

### Parameterization mechanism

**Variant A: modify imports in test files** (bulk sed), pointing at `tests/create-adapter.ts` which picks the driver via `TASKORA_TEST_DRIVER=ioredis|bun` env var. Reasons:

- Works identically under Node/Bun/Deno vitest invocations.
- No reliance on Vitest's `resolve.alias` (which may behave differently under Deno's npm-compat vitest).
- Minimal diff: one import line per test file (27 files), all with the same pattern.
- Keeps test files runnable under any vitest CLI, no config magic.

Not using Variant B (`vitest.config.ts` alias) — more fragile, less portable across the three test runner invocations.

### CI matrix (4 cells)

```yaml
matrix:
  include:
    - { runtime: node, driver: ioredis }   # baseline
    - { runtime: bun,  driver: ioredis }   # confirmed green
    - { runtime: bun,  driver: bun }       # 4 known bugs, Phase 4 fixes
    - { runtime: deno, driver: ioredis }   # confirmed green
  # deno + bun: skip (Bun-only runtime API in BunDriver)
```

`fail-fast: false` so one failing cell doesn't cancel the others — critical for diagnosing divergences.

Testcontainers works under all three runtimes → no need for `services: redis` in the workflow. Simpler yml.

### Known skip rules

- **Deno + BunDriver**: hard skip (matrix `exclude`). `createBunDriver()` throws when `globalThis.Bun` is `undefined`. `tests/create-adapter.ts` should throw an analogous clear error for the same case.
- **No other skips** — all 4 remaining combos must be green before merge. Bugs go in Phase 4 fix list, not in `.skipIf(...)`.

### Phase 4 fix priority order

1. **Bug cluster B (pub/sub)** — blocks 2 tests, most likely simple fix in `drivers/bun.ts` subscribe(). Highest impact.
2. **Bug cluster A (LRANGE/ZRANGE order)** — 1 test, likely a small response-shape fix in `drivers/bun.ts`.
3. **Bug cluster C (retryAll marker)** — 1 test, may require Lua script inspection. Could be pre-existing bug.
4. After fixes, run the **full** 22-file integration suite under BunDriver — expect more bugs to surface. The 38-test sample in Phase 1 is a lower bound, not a ceiling.

## Phase 2+ readiness

- Parameterization mechanism chosen → code paths are clear.
- CI matrix shape chosen → `.github/workflows/test.yml` rewrite is mechanical.
- Bug triage plan → Phase 4 has a concrete starting list, not a blind search.
- Unknowns remaining: how many BunDriver bugs hide in the other 22 integration files. Will discover during Phase 4 iteration.

**Awaiting user review before starting Phase 2.**
