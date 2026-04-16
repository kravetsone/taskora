# Wire format contract

This document is the authoritative list of everything taskora persists that
another taskora process might read. If you change any of it, **you must bump
`WIRE_VERSION` in `src/wire-version.ts`** (and usually `MIN_COMPAT_VERSION`
too — see the policy at the bottom).

The constants and compatibility rule live in `src/wire-version.ts`. The
runtime check that enforces them lives in `App.ensureConnected()` via
`adapter.handshake()`.

## Scope

### What counts as "wire format"

Any change to the following is a wire-format change:

1. **Key layout** — names, prefixes, hash-tag placement
2. **Job hash fields** — names and encoding of fields written to
   `{prefix}{task}:{id}`
3. **Sorted-set score semantics** — what the `ZADD` score means in each set
4. **Stream event shapes** — the fields attached to `XADD <task>:events *`
5. **Lua script semantics** — any change that alters how the Lua scripts
   interpret or mutate shared state, even if the Lua source is hashed by SHA
   per-version (because two processes running different Lua will still hit
   the same keys)
6. **Meta hash fields** — the structure of `taskora:meta` itself
7. **Collect / debounce / throttle / dedup key structure**
8. **Workflow hash layout** — `taskora:wf:{id}` fields and nested encodings
9. **Scheduler persistence** — `taskora:schedules` hash, `schedules:next` zset,
   `schedules:lock` string

### What doesn't count

* Public TypeScript API shape (covered by semver)
* User task payload shape (covered by per-task `_v` + `migrate` — see
  `docs/IMPLEMENTATION.md` §9)
* Internal module layout / file paths
* Bun vs ioredis driver choice
* The `SCRIPT LOAD` SHA — each process loads its own

## Current surface (wireVersion = 6)

### Keys

| Key | Type | Purpose |
|---|---|---|
| `taskora:meta` | Hash | Wire-format meta record (this doc's subject) |
| `taskora:<prefix>:meta` | Hash | Same, per-prefix |
| `taskora:{<task>}:wait` | List | Non-priority waiting job IDs (priority == 0). LPUSH at the head, RPOP from the tail. Strict FIFO. O(1) dequeue — the common-case fast path |
| `taskora:{<task>}:prioritized` | Sorted set | Priority-dispatched (priority > 0) waiting job IDs, keyed by composite score `-(priority * 1e13) + ts`. `ZPOPMIN` yields the highest-priority job, FIFO within a band. Only consulted when `:wait` is empty |
| `taskora:{<task>}:active` | List | Claimed-but-not-finished job IDs |
| `taskora:{<task>}:delayed` | Sorted set | Score = run-at epoch ms |
| `taskora:{<task>}:completed` | Sorted set | Score = finish epoch ms |
| `taskora:{<task>}:failed` | Sorted set | Score = finish epoch ms |
| `taskora:{<task>}:expired` | Sorted set | Score = expiry epoch ms |
| `taskora:{<task>}:cancelled` | Sorted set | Score = cancel epoch ms |
| `taskora:{<task>}:cancel` | Pub/sub channel | Instant cancel signal (jobId payload) |
| `taskora:{<task>}:events` | Stream | XADD stream of job lifecycle events |
| `taskora:{<task>}:stalled` | Set | Active IDs checked by stall sweep |
| `taskora:{<task>}:marker` | Sorted set | BZPOPMIN wake-up marker |
| `taskora:{<task>}:<id>` | Hash | Job metadata + serialized `data` + serialized `result` (see fields below) |
| `taskora:{<task>}:<id>:lock` | String (PX) | Distributed lock token (stays separate — needs `SET … PX` atomicity) |
| `taskora:{<task>}:<id>:logs` | List | `ctx.log.*` entries (capped) |
| `taskora:{<task>}:debounce:<key>` | String | Debounce placeholder job ID |
| `taskora:{<task>}:throttle:<key>` | Sorted set | Throttle window timestamps |
| `taskora:{<task>}:dedup:<key>` | String | Dedup placeholder job ID |
| `taskora:{<task>}:collect:<key>:items` | List | Collect buffer items |
| `taskora:{<task>}:collect:<key>:meta` | Hash | Collect buffer meta |
| `taskora:{<task>}:collect:<key>:job` | String | Collect flush sentinel job ID |
| `taskora:{<task>}:conc:<key>` | String | Per-key concurrency counter |
| `taskora:schedules` | Hash | Schedule name → serialized config |
| `taskora:schedules:next` | Sorted set | Schedule name → next-run epoch ms |
| `taskora:schedules:lock` | String (PX) | Scheduler leader election |
| `taskora:wf:<id>` | Hash | Workflow graph + per-node state/result |
| `taskora:throughput:<task>:<minute>` | String (TTL 24h) | Per-minute completion counter |

### Meta hash (`taskora:meta`)

| Field | Type | Purpose |
|---|---|---|
| `wireVersion` | integer | The wire-format version of the writer |
| `minCompat` | integer | Lowest wire version the writer promised to stay readable by |
| `writtenBy` | string | Writer identifier (e.g. `taskora@0.2.0`) |
| `writtenAt` | epoch ms | Timestamp when the meta was first written |

### Job hash (`taskora:{<task>}:<id>`)

Stable fields (reading or writing any of these by a new name is a wire change):

| Field | Type | Purpose |
|---|---|---|
| `state` | string | `waiting` / `active` / `completed` / `failed` / `retrying` / `expired` / `cancelled` |
| `_v` | integer | User task payload version (Phase 9) |
| `attempt` | integer | 1-based attempt counter |
| `maxAttempts` | integer | Total attempts allowed |
| `priority` | integer | Queue priority |
| `ts` | epoch ms | Enqueue timestamp |
| `processedOn` | epoch ms | First moved to active |
| `finishedOn` | epoch ms | Terminal state entry |
| `stalledCount` | integer | Times recovered from stall |
| `cancelledAt` | epoch ms | Cancel-flag timestamp (for in-flight cancel) |
| `cancelReason` | string | User-supplied cancel reason |
| `error` | string | Last failure message |
| `expireAt` | epoch ms | TTL expiry (0 = disabled) |
| `concurrencyKey` | string | Per-key concurrency bucket |
| `concurrencyLimit` | integer | Per-key concurrency cap |
| `_wf` | string | Owning workflow ID (empty = not in a workflow) |
| `_wfNode` | integer | Owning workflow node index |
| `collectKey` | string | Collect-flush sentinel marker |
| `data` | string | Serialized input payload (lives in the hash since wireVersion 6) |
| `result` | string | Serialized output payload (lives in the hash since wireVersion 6; present on completed jobs) |

### Stream events (`<task>:events`)

| Event | Required fields |
|---|---|
| `active` | `id`, `attempt` |
| `completed` | `id`, `result`, `duration`, `attempt` |
| `failed` | `id`, `error`, `attempt` |
| `retrying` | `id`, `error`, `attempt`, `nextAttemptAt` |
| `progress` | `id`, `value` |
| `stalled` | `id`, `count`, `action` (`recovered` / `failed`) |
| `cancelled` | `id`, `reason?` |

## Bump policy

The two constants in `src/wire-version.ts` change **only** when the wire
format itself changes — never on a taskora release that only touches TS
types, docs, refactors, or CI. Keeping these decoupled from `package.json`
is deliberate: it removes a manual step that would otherwise be easy to
forget and silently corrupt production queues.

### `WIRE_VERSION` — bump on every wire change

Increment by 1 for any change to the tables above, whether additive or not.
Even adding a field that nobody reads yet counts: the version number is how
a running process detects that *anything* changed at all.

### `MIN_COMPAT_VERSION` — bump only on actual breaks

Increment **only** when the change makes data written by this version
unreadable or misinterpretable by a process running the *previous*
wire version. The common case — adding a new optional hash field that
older code simply ignores — leaves `MIN_COMPAT_VERSION` alone. That is
what lets an older and newer taskora run against the same Redis during
a rolling upgrade: their `[minCompat, wireVersion]` windows overlap.

| Change                                                       | `WIRE_VERSION` | `MIN_COMPAT_VERSION` |
|--------------------------------------------------------------|:---:|:---:|
| Add new optional hash field old code ignores                 | +1  |  —  |
| Add a new stream event type old code doesn't subscribe to    | +1  |  —  |
| Add a brand-new key old code never touches                   | +1  |  —  |
| Rename an existing stable hash field                         | +1  | +1  |
| Change the meaning of an existing sorted-set score           | +1  | +1  |
| Remove a field the old Lua still `HGET`'s                    | +1  | +1  |
| Swap the encoding of an existing field (string → json)       | +1  | +1  |

When in doubt, assume the change is a break and bump both. An unnecessary
`MIN_COMPAT_VERSION` bump only costs a forced full-stop upgrade; the
opposite mistake corrupts queues in production.

### What about `writtenBy`?

There is no separate build-id constant to bump. `SchemaMeta.writtenBy` is
derived from `WIRE_VERSION` at runtime as `taskora-wire-<N>` — so a release
that doesn't change the wire format doesn't touch this file at all.

### What you do NOT bump for

* A `package.json` version bump with no wire change
* A public TypeScript API change (types only)
* A refactor or rename inside `src/` that leaves the Redis layout identical
* A doc, test, or CI-only change
* A task-level payload change (that's Phase 9 — `_v` + `migrate`, not this)

### Checklist for a wire-format change

1. [ ] Update the tables above so the new stable surface is captured
2. [ ] Bump `WIRE_VERSION` in `src/wire-version.ts`
3. [ ] Decide: is this a break for older readers?
   - Yes → also bump `MIN_COMPAT_VERSION`
   - No  → leave `MIN_COMPAT_VERSION` alone (enables rolling upgrade)
4. [ ] Add a short note to the phase tracker in `docs/IMPLEMENTATION.md`
   describing the wire change and its motivation

## Version history

### 1 → 2 (priority-aware wait list)

The wait list changed from `List` to `Sorted set`. Every Lua script that
touched it (`enqueue`, `moveToActive`, `nack`, `stalledCheck`, `retryDLQ`,
`retryAllDLQ`, `cancel`, `throttleEnqueue`, `deduplicateEnqueue`,
`collectPush`, `versionDistribution`, `listJobDetails`) was rewritten from
`LPUSH`/`RPUSH`/`RPOP`/`LLEN`/`LRANGE`/`LREM` to
`ZADD`/`ZPOPMIN`/`ZCARD`/`ZRANGE`/`ZREM`. The composite score is
`-(priority * 1e13) + ts` so `ZPOPMIN` always yields a higher-priority
waiting job before any lower-priority one. Within a priority band
ordering is best-effort — not a FIFO contract.

This was done to implement `DispatchOptions.priority`, which was a
decorative no-op on wireVersion=1 (the priority field was stored in the
job hash but nothing sorted the wait list by it).

**Upgrade is automatic.** Redis key type is part of the persisted layout
— a wireVersion=1 process reading a `ZADD`-created wait set crashes with
`WRONGTYPE` and vice versa — so the two formats cannot coexist. But a
wireVersion=2 `RedisBackend.handshake()` detects a stored wireVersion=1
meta record and runs an in-place `:wait` migrator before returning: for
every `taskora:*:wait` key it finds of type `list`, it reads all job
IDs, looks up each job's `priority` and `ts` fields, computes scores,
and atomically replaces the list with a sorted set carrying the same
members. Workers never run during this — `App.ensureConnected()` holds
them off until the handshake resolves. The migrator chunks its work so
Redis is never blocked on a single huge script; see
`RedisBackend.migrateWaitV1ToV2` for pacing details.

Operators upgrading existing clusters should see a one-line log entry
at `app.start()` the first time a wireVersion=2 process connects to a
wireVersion=1 keyspace, and nothing more. `MIN_COMPAT_VERSION` is still
bumped to 2 so two processes running the old and new versions side by
side against the same Redis can never observe each other mid-migration
— the handshake refuses the mismatched pair.

### 5 → 6 (single-hash job storage)

Every job used to occupy four Redis keys:

* `taskora:{<task>}:<id>` — metadata hash (`state`, `_v`, `attempt`, …)
* `taskora:{<task>}:<id>:data` — serialized input string
* `taskora:{<task>}:<id>:result` — serialized output string
* `taskora:{<task>}:<id>:lock` — worker lock string (PX)

wireVersion 6 collapses `:data` and `:result` into fields named `data`
and `result` on the metadata hash itself. The lock stays separate —
Redis `SET key val PX ttl` is the only atomic "set + millisecond
expiration" primitive, and the lock is on the critical path. Moving it
into the hash would require `HEXPIRE` (Redis 7.4+), which taskora
intentionally does not mandate.

Hot-path impact (see `docs/IMPLEMENTATION.md` §phase-3b for full
numbers):

* **Enqueue** — one fewer `redis.call()` (the `SET <id>:data` collapses
  into the same `HSET` that writes the other metadata fields).
* **Claim** — one fewer (`GET <id>:data` folds into the same `HMGET`
  that already reads `_v`, `attempt`, `ts`).
* **Ack** — one fewer (`SET <id>:result` folds into the `HSET` that
  writes `state`, `finishedOn`).

Three calls per job vanish on the happy path. At c=100 that's ~16 % of
the per-script Redis CPU, stacked on top of Phase 3A's O(1) wait-list
dequeue.

**Memory tradeoff** — for payloads that fit inside the hash listpack
encoding, the new layout uses ~50 % less Redis memory per job (one
hash at ~150 B vs hash + two strings + keyspace overhead at ~320 B).
Redis 7 keeps a hash in listpack form as long as:

* number of fields ≤ `hash-max-listpack-entries` (default 128)
* every value ≤ `hash-max-listpack-value` bytes (default 64)

If any job's `data` or `result` exceeds 64 bytes, the hash flips to
`hashtable` encoding, where the per-field overhead jumps from ~2 B to
~80 B. Under that encoding the single-hash layout can briefly be
*larger* than the old split layout for payloads in the 64-to-1024 B
window. The cure is operator-side, one line in `redis.conf`:

```
hash-max-listpack-value 1024
```

BullMQ gives the same recommendation (implicitly, because it has
always used single-hash storage). With that tuning, payloads up to
~1 KB stay in listpack and single-hash is a memory win across the
board.

**Upgrade is a hard gate.** A wireVersion=5 worker that issues
`GET <id>:data` against a wireVersion=6 job hits `nil` — the string
sibling no longer exists — and silently drops the payload.
`MIN_COMPAT_VERSION` bumps to 6 so `handshake()` refuses the
mismatched pair. Drain queues or flush the keyspace before rolling
workers.

**Automatic migration.** The first wireVersion=6 process to connect
acquires the shared migration lock and runs `MIGRATE_JOBS_V5_TO_V6`:
it SCANs the keyspace for `:data` and `:result` string siblings and
invokes a small per-key Lua script for each hit, copying the string
value into the sibling hash as the matching field and deleting the
string. The script is idempotent (already-migrated jobs and orphaned
siblings are no-ops), so a partial run followed by a retry picks up
where it left off. See `RedisBackend.migrateJobsV5ToV6` and
`scripts.MIGRATE_JOBS_V5_TO_V6` for details.
