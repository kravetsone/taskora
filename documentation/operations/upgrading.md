# Upgrading Taskora

**Upgrade taskora the way you'd upgrade any other dependency — bump the version, redeploy, carry on.** We've thought hard about this and built several layers of machinery specifically so you don't have to worry about it. This page explains what's in place, not what you have to do.

## Why you can just upgrade

Taskora's storage layout (keys, Lua scripts, job hash fields, stream events) is treated as a load-bearing contract. We've put a belt-and-suspenders system in place to make sure a release that would silently break your production queues cannot land. Here's what's protecting you:

**A frozen wire-format snapshot runs on every CI build.** `tests/unit/wire-format-snapshot.test.ts` pins down every Redis key the library constructs, the SHA-256 of every Lua script we ship, and both version constants. Any PR that drifts a single character of the persistence surface — a key rename, a comment tweak in a Lua script, a new stable hash field — fails CI with a clear "you are touching the wire format" reminder. A drive-by edit cannot sneak through review.

**The version constants are decoupled from `package.json`.** A bug-fix release that never touches storage doesn't move `WIRE_VERSION` or `MIN_COMPAT_VERSION`. The identifier stored in your Redis (`taskora-wire-<N>`) stays stable across every release that doesn't change the format, so there is no "did I remember to bump the version on release day" failure mode.

**Rolling upgrades work by default for the common case.** When a new version adds a field or a new event that older code simply ignores, both versions can run against the same Redis simultaneously — their compatibility windows overlap automatically. No coordination, no downtime, no staged rollout required.

**A runtime handshake runs before workers touch anything.** On `app.start()`, taskora does one small atomic read-or-init against a `taskora:meta` record in your Redis, compares the stored wire version against the running build's own, and stops the process dead before any worker, scheduler, or dispatch runs if they don't line up. The worst case is a clean exit with a clear error — your data is never in an ambiguous state.

**Breaking wire changes are reserved for major releases, if we do them at all.** Cosmetic renames and "while I'm in here" cleanups will never change the format. The actual bar for a breaking change is "we couldn't fix a real correctness bug any other way," and even then we'd prefer to ship an additive escape hatch first.

**A built-in wire-format upgrader is wired into the handshake.** When a taskora release genuinely has to change the persisted format, the new version ships with a Lua migrator that runs atomically as part of `app.start()`'s handshake against the storage backend. You deploy the new version, the first worker to reach `app.start()` notices the format needs upgrading, runs the in-place conversion, bumps the stored wire-version marker, and continues as normal. The migration is per-key atomic (via a single Lua script per shared data structure, so no concurrent writer can interleave), idempotent (safe to re-run if interrupted), and paced across the keyspace via `SCAN` so Redis is never blocked on one huge script. You should see a one-line log entry like `[taskora] migrated N :wait lists to wireVersion M` and nothing else. For the operator journal the important thing is: **there is nothing to do but deploy.**

**A cluster-wide coordination protocol keeps multiple workers safe during a migration.** When a wire-format change rolls out, it's normal to have a mix of old-version and new-version workers alive at the same time — that's just what deployment looks like. Taskora reserves two keys for exactly this case:

- `taskora:<prefix>:migration:lock` — a short-lived marker set by whichever worker is running the migration, with a JSON payload naming the target version (`{ targetWireVersion, reason, startedAt, expectedDurationMs }`) and a finite TTL so a crashed migrator can't pin the cluster forever.
- `taskora:<prefix>:migration:broadcast` — a pub/sub channel used to signal "re-check the lock" to every subscribed worker, so the pause happens instantly instead of waiting for the next periodic poll.

Every taskora release from wireVersion=2 onward subscribes to the broadcast channel on startup and watches the lock. When it sees a lock whose `targetWireVersion` covers its own wire version, it pauses all hot-path Redis operations (dispatches, dequeues, updates) until the lock clears — no writes, no reads of data that might be mid-rewrite. When the lock is released (or its TTL expires), workers resume automatically. A safety-net poller re-checks the lock every 30 seconds in case a broadcast message is missed during a reconnect. Cluster races are resolved by `SET NX` on the lock: if ten new-version workers start simultaneously against an old-version keyspace, exactly one acquires the lock and runs the migration, the other nine park until it finishes and then re-handshake cleanly.

This is all automatic and invisible to your application code — `task.dispatch()` that happens to fall during a migration simply takes slightly longer to resolve, no errors, no retries required. The whole protocol exists so that the answer to "what do I need to do to upgrade taskora across a breaking wire change?" stays **"nothing — deploy the new version, keep working"**.

Put together: the compatibility error documented below should not happen to you in practice. It's the last line of defense, present so that **if** something ever does slip through the combination of CI snapshot tests, bump policy, rolling-upgrade semantics, auto-migration, and code review, the failure mode is a clean fail-fast at startup — not silently corrupted queues.

## What it looks like if you do hit it

`app.start()` throws `SchemaVersionMismatchError`. No data is mutated, no jobs are lost. The error carries structured fields you can feed into logs and alerts:

```ts
import { SchemaVersionMismatchError } from "taskora"

try {
  await app.start()
} catch (err) {
  if (err instanceof SchemaVersionMismatchError) {
    // err.code: "theirs_too_new" | "theirs_too_old" | "invalid_meta"
    // err.ours:   { wireVersion, minCompat, writtenBy }
    // err.theirs: { wireVersion, minCompat, writtenBy, writtenAt }
    console.error(err.message)
    process.exit(1)
  }
  throw err
}
```

The `code` field tells you what's going on and how to resolve it:

| Code | Meaning | Resolution |
|---|---|---|
| `theirs_too_new` | A newer taskora build already wrote to this Redis | Upgrade this process to match, or point it at a different Redis keyspace |
| `theirs_too_old` | This Redis was written by a much older taskora | Upgrade in smaller steps, or drain the old queues first |
| `invalid_meta` | The `taskora:meta` hash is corrupt or written by something else | Investigate who wrote it; if it's garbage, delete the key and retry |

You should never have to use this table, but it's here in case you do.

## Known breaking upgrades

Most releases are additive and roll through without intervention. When a release changes the persisted format in a way that the previous version cannot read, we call it out here. In every case we aim to ship an automatic migrator so operators still just "upgrade taskora, redeploy, done" — you should only ever need to read these sections if something goes wrong.

### wireVersion 1 → 2 — priority-aware wait list

**What changed.** The `:wait` list was promoted from a Redis `List` to a `Sorted set` so `DispatchOptions.priority` can actually order dequeues. Before this release, `priority` was a decorative field — stored on the job hash but completely ignored by the wait-list dequeue path. A wireVersion=2 worker now always dequeues a higher-priority waiting job before any lower-priority one.

**Upgrade is automatic.** `RedisBackend.handshake()` detects stored wireVersion=1 meta on connect and runs an in-place migrator before any worker or scheduler touches the backend. The migrator walks the keyspace with `SCAN`, and for every `:wait` key of type `list` it reads all job IDs via chunked `LRANGE`, pipelines `HMGET priority,ts` lookups in batches, computes scores, and atomically swaps the list for a sorted set carrying the same members via a tiny `DEL + RENAME` Lua script. Redis is never blocked on a long script — chunk size is bounded to 500 IDs per batch — so even a keyspace with thousands of tasks and millions of waiting jobs migrates without triggering timeouts or failover.

You should see a one-line log entry the first time a wireVersion=2 process starts against a wireVersion=1 Redis ("migrated N `:wait` lists to sorted sets") and nothing more. If the migration fails mid-run (e.g. Redis disconnects), the next `app.start()` retries from wherever it left off — individual `:wait` conversions are atomic per key, so partial state is safe to resume.

**Why a rolling upgrade with mixed v1 and v2 workers is still not safe.** `DispatchOptions.priority` is implemented by switching the `:wait` key from a Redis `List` to a `Sorted set` — a wireVersion=1 worker reading a `ZADD`-created wait set hits `WRONGTYPE` on the first `LPUSH`/`RPOP`, and vice versa. v1 predates the migration coordination protocol: it doesn't subscribe to the broadcast channel and doesn't check the lock, so a running v1 worker can't be asked to pause. `MIN_COMPAT_VERSION` is bumped to 2 so if you do run both versions against one Redis during a staged rollout, v1's handshake refuses to start with a `theirs_too_new` error — you never get a half-converted keyspace, but v1 instances already past handshake will crash when they next touch `:wait`. Stop v1 workers before starting v2.

**From wireVersion 2 onward this gets easier.** The coordination protocol described above is wired in as of v2, so future wire-format changes (v2 → v3 and beyond) can run with live workers on both sides. The new-version migrator will acquire the migration lock, broadcast the halt signal, and old-version workers will pause automatically while the rewrite runs. v1 → v2 is the one exception you'll have to think about — every upgrade after it should be invisible.

**If you'd rather migrate manually.** The auto-migrator is idempotent and you can skip it by draining the `:wait` lists yourself before switching versions: stop dispatching, wait for in-flight work to finish, confirm `LLEN taskora:{<task>}:wait` is zero on every task, then deploy. Nothing breaks if you do — the new version just finds an empty keyspace and writes fresh sorted sets from scratch.

## Not to be confused with task payload versioning

There are two independent versioning systems in taskora. They solve different problems and you'll interact with them at very different frequencies.

| | Wire format (this page) | Task payload ([Versioning & Migrations](../features/versioning)) |
|---|---|---|
| **Protects** | taskora's own Redis layout | your task's input data shape |
| **Bumped by** | taskora maintainers, rarely | you, whenever you evolve a task schema |
| **Configured in** | taskora source (internal) | `app.task({ version, since, migrate })` |
| **How often it matters** | almost never — we made sure | every time you change task input |

If you're looking for "how do I change my task's input schema without breaking in-flight jobs," that's the second column and it's covered in [Versioning & Migrations](../features/versioning).

## TL;DR

- Upgrade taskora, redeploy, done.
- The compatibility machinery is there so you don't have to think about it.
- `SchemaVersionMismatchError` is the last-resort safety net — in practice our CI snapshot tests, bump policy, and rolling-upgrade semantics mean you shouldn't see it.
- Wire-format versioning is the library's own internal safety net. Task payload versioning is the separate, user-facing mechanism for evolving your own tasks.
