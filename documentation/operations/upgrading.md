# Upgrading Taskora

**Upgrade taskora the way you'd upgrade any other dependency — bump the version, redeploy, carry on.** We've thought hard about this and built several layers of machinery specifically so you don't have to worry about it. This page explains what's in place, not what you have to do.

## Why you can just upgrade

Taskora's storage layout (keys, Lua scripts, job hash fields, stream events) is treated as a load-bearing contract. We've put a belt-and-suspenders system in place to make sure a release that would silently break your production queues cannot land. Here's what's protecting you:

**A frozen wire-format snapshot runs on every CI build.** `tests/unit/wire-format-snapshot.test.ts` pins down every Redis key the library constructs, the SHA-256 of every Lua script we ship, and both version constants. Any PR that drifts a single character of the persistence surface — a key rename, a comment tweak in a Lua script, a new stable hash field — fails CI with a clear "you are touching the wire format" reminder. A drive-by edit cannot sneak through review.

**The version constants are decoupled from `package.json`.** A bug-fix release that never touches storage doesn't move `WIRE_VERSION` or `MIN_COMPAT_VERSION`. The identifier stored in your Redis (`taskora-wire-<N>`) stays stable across every release that doesn't change the format, so there is no "did I remember to bump the version on release day" failure mode.

**Rolling upgrades work by default for the common case.** When a new version adds a field or a new event that older code simply ignores, both versions can run against the same Redis simultaneously — their compatibility windows overlap automatically. No coordination, no downtime, no staged rollout required.

**A runtime handshake runs before workers touch anything.** On `app.start()`, taskora does one small atomic read-or-init against a `taskora:meta` record in your Redis, compares the stored wire version against the running build's own, and stops the process dead before any worker, scheduler, or dispatch runs if they don't line up. The worst case is a clean exit with a clear error — your data is never in an ambiguous state.

**Breaking wire changes are reserved for major releases, if we do them at all.** Cosmetic renames and "while I'm in here" cleanups will never change the format. The actual bar for a breaking change is "we couldn't fix a real correctness bug any other way," and even then we'd prefer to ship an additive escape hatch first.

**A built-in wire-format upgrader is on the roadmap.** The long-term goal is that a future taskora release can read the previous format, transparently rewrite persisted data to the new layout on first connect, and carry on — no downtime, no error, nothing for you to catch. Once that lands, even a breaking wire change becomes invisible at upgrade time.

Put together: the compatibility error documented below should not happen to you in practice. It's the last line of defense, present so that **if** something ever does slip through the combination of CI snapshot tests, bump policy, rolling-upgrade semantics, and code review, the failure mode is a clean fail-fast at startup — not silently corrupted queues.

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

**Why a rolling upgrade is still not safe.** A wireVersion=1 worker reading a `ZADD`-created wait set hits `WRONGTYPE` on the first `LPUSH`/`RPOP`, and vice versa. `MIN_COMPAT_VERSION` is bumped to 2 so if you do run both versions against one Redis during a staged rollout, the handshake refuses the old process with a `theirs_too_new` error — you never get a half-converted keyspace. The upgrader makes the *one-shot* upgrade seamless; it does not make the two versions coexist.

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
