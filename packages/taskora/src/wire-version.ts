/**
 * Wire format versioning for taskora.
 *
 * ## What this protects
 *
 * The *wire format* is everything taskora writes into its storage backend
 * (Redis, and future Postgres) that another taskora process might read:
 *
 *   • Key layout and naming — `taskora:{task}:wait`, `{id}:data`, `{id}:result`, …
 *   • Job hash field names and their expected encodings
 *     (`state`, `attempt`, `_v`, `stalledCount`, `cancelledAt`, `_wf`, `_wfNode`,
 *     `expireAt`, `maxAttempts`, `processedOn`, `finishedOn`, …)
 *   • Stream event shapes — the fields attached to XADD entries on `<task>:events`
 *     (completed/failed/retrying/progress/stalled/cancelled)
 *   • Lua script semantics over shared state (ACK/FAIL/NACK/…) — renaming a
 *     hash field or changing how it is interpreted counts as a wire change even
 *     though the Lua source itself is hashed by SHA per-version
 *   • Sorted-set score meanings (delayed = run-at ms, completed/failed = finish ms, …)
 *
 * NOT the wire format:
 *   • Public TypeScript API — covered by semver normally
 *   • The user's task payload shape — covered by Phase 9 (`_v` + `migrate`)
 *   • Internal module/file layout
 *   • Bun vs ioredis driver choice
 *
 * ## The check
 *
 * When {@link App.ensureConnected} runs, it calls `adapter.handshake(ours)`.
 * The adapter atomically reads (and, if absent, initializes) a small meta
 * record in the storage backend; it then returns whatever meta is in effect.
 *
 * Core compares the returned meta against the {@link SchemaMeta} compiled into
 * *this* process via {@link checkCompat}. If the two are incompatible, core
 * throws {@link SchemaVersionMismatchError} before any worker, scheduler, or
 * dispatch can touch the backend.
 *
 * ## What to bump, and when
 *
 * Only two things in this file carry semantic weight — and both change ONLY
 * when the wire format itself changes. They are intentionally decoupled from
 * `package.json`'s version: a taskora release that fixes a typo or adds a
 * public TypeScript overload must not touch either constant.
 *
 * ### {@link WIRE_VERSION}
 *
 * Bump by +1 whenever you make ANY change to the surface listed in
 * `docs/WIRE_FORMAT.md` — a new stable hash field, a renamed key, a tweaked
 * sorted-set score meaning, a Lua script that reinterprets a field, etc.
 * Even additive changes get a bump: the version is how a running process
 * knows "something changed" at all.
 *
 * ### {@link MIN_COMPAT_VERSION}
 *
 * Bump ONLY when the change you just made is backward-incompatible for older
 * *readers*. In other words, when a process running the previous wire
 * version would misinterpret, crash on, or silently corrupt data written by
 * this version.
 *
 * The common case — adding a new optional field that older Lua/TS code
 * simply ignores — is NOT a break, so `MIN_COMPAT_VERSION` stays put. That
 * is how rolling upgrades work: `[minCompat, wireVersion]` widens on the
 * newer process, the old process's unchanged window still overlaps, the
 * compatibility check passes, and they coexist on one Redis.
 *
 * Examples:
 *
 * | Change                                                         | WIRE | MIN  |
 * |----------------------------------------------------------------|------|------|
 * | Add new optional hash field old code ignores                   | +1   |  —   |
 * | Add a new stream event type old code doesn't subscribe to      | +1   |  —   |
 * | Add a brand-new key old code never touches                     | +1   |  —   |
 * | Rename an existing stable hash field                           | +1   | +1   |
 * | Change the meaning of an existing sorted-set score             | +1   | +1   |
 * | Remove a field the old Lua still HGET's                        | +1   | +1   |
 * | Swap the encoding of an existing field (string → json)         | +1   | +1   |
 *
 * When in doubt, assume break and bump both. An unnecessary `MIN_COMPAT`
 * bump only costs a forced full-stop upgrade; the opposite mistake corrupts
 * queues in production.
 *
 * ### `writtenBy` identifier
 *
 * `SchemaMeta.writtenBy` is derived from {@link WIRE_VERSION} at runtime
 * (see {@link currentMeta}) rather than stored as its own constant. There
 * is nothing to forget to update: it changes exactly when the wire version
 * changes, and only then.
 *
 * ### Anti-checklist — things you do NOT bump for
 *
 *   • A `package.json` version bump that doesn't touch the wire format
 *   • A public TypeScript API change (types only)
 *   • A refactor or rename inside `src/` that doesn't move data on the wire
 *   • A doc, test, or CI-only change
 *   • A task-level payload change (that's Phase 9 — `_v` + `migrate`)
 */

/**
 * The wire-format version this build of taskora writes and expects to read.
 * Monotonically increasing integer. Bumped whenever the layout listed in
 * `docs/WIRE_FORMAT.md` changes, additive or not. Do NOT bump on release.
 *
 * ── History ──
 *   1 → 2: wait list changed from Redis LIST to SORTED SET so
 *          `DispatchOptions.priority` can actually order dequeues by
 *          (priority desc, ts asc). Every Lua script that touched the
 *          wait list via LPUSH/RPUSH/RPOP/LLEN/LRANGE/LREM was rewritten
 *          to ZADD/ZPOPMIN/ZCARD/ZRANGE/ZREM. A Redis instance containing
 *          wire-version-1 `:wait` LIST data cannot be read by a
 *          wire-version-2 process (WRONGTYPE on first ZADD) and vice
 *          versa — this is a hard upgrade, not a rolling one. Drain the
 *          waits (or flush the keyspace) before switching versions.
 *   2 → 3: purely additive. Two new Lua scripts shipped —
 *          ACK_AND_MOVE_TO_ACTIVE and FAIL_AND_MOVE_TO_ACTIVE — that fuse
 *          ack+dequeue (and fail+dequeue) into a single EVALSHA so each
 *          worker slot can self-feed without funneling through the poll
 *          loop. No key layout, hash field, or sorted-set score meaning
 *          changed; existing ACK/FAIL/MOVE_TO_ACTIVE scripts are still
 *          present and produce identical Redis state. Wire-version-2
 *          readers can safely share a backend with wire-version-3 writers,
 *          so `MIN_COMPAT_VERSION` stays at 2 and rolling upgrades work.
 */
export const WIRE_VERSION = 3;

/**
 * The oldest wire-format version this build is still willing to coexist
 * with. Must always satisfy `MIN_COMPAT_VERSION <= WIRE_VERSION`.
 *
 * Bumped ONLY when the most recent wire change was genuinely
 * backward-incompatible for older readers (see the example table in this
 * file's top-of-file comment). Additive changes must leave this alone —
 * that is exactly what enables rolling upgrades.
 *
 * When this equals `WIRE_VERSION` the check is a hard gate: two processes
 * must run identical wire versions to share one backend.
 *
 * The 1 → 2 bump is such a hard gate. Wait-list type (LIST → ZSET) cannot
 * round-trip between versions, so `MIN_COMPAT_VERSION` must also be 2.
 */
export const MIN_COMPAT_VERSION = 2;

/**
 * A taskora wire-format meta record. Persisted once per `(backend, prefix)`
 * pair by the first process to connect; every subsequent process validates
 * its own compiled constants against the stored copy.
 */
export interface SchemaMeta {
  /** The wire-format version of the writing process. */
  wireVersion: number;
  /** The oldest wire-format version the writer promised it can still handle. */
  minCompat: number;
  /**
   * Identifier of the writer, derived from its wire version (not from
   * `package.json`). Used purely for operator-facing error messages.
   */
  writtenBy: string;
  /** Unix milliseconds timestamp at write time. */
  writtenAt: number;
}

/**
 * Derives the `writtenBy` identifier for a given wire version. Exported so
 * tests can assert the format without re-deriving it, and so any future
 * tooling that wants to parse the field has a single source of truth.
 *
 * Intentionally tied to `WIRE_VERSION` and nothing else — there is no
 * separate constant to keep in sync with `package.json`, which means a
 * release that doesn't change the wire format doesn't touch this file at all.
 */
export function writtenByForWireVersion(wireVersion: number): string {
  return `taskora-wire-${wireVersion}`;
}

/**
 * The meta record this running build would persist if it were the first to
 * touch the backend.
 */
export function currentMeta(now: number = Date.now()): SchemaMeta {
  return {
    wireVersion: WIRE_VERSION,
    minCompat: MIN_COMPAT_VERSION,
    writtenBy: writtenByForWireVersion(WIRE_VERSION),
    writtenAt: now,
  };
}

/**
 * Result of comparing our compiled meta against the meta persisted in the
 * backend.
 */
export type CompatResult =
  | { ok: true }
  | {
      ok: false;
      /** Short machine-readable reason code. */
      code: "theirs_too_new" | "theirs_too_old" | "invalid_meta";
      /** Human-readable explanation safe to include in an error. */
      message: string;
    };

/**
 * Pure compatibility check. No I/O, no exceptions — just data in, verdict out.
 *
 * Compatibility rule (symmetric, window-based):
 *   theirs.wireVersion  ∈  [ours.minCompat, +∞)   — we are willing to read theirs
 *   ours.wireVersion    ∈  [theirs.minCompat, +∞) — they were willing to read ours
 *
 * Both windows must overlap; if either side's `wireVersion` falls below the
 * other side's `minCompat`, the pair is incompatible and we refuse to start.
 *
 * The equal-version case trivially passes both checks.
 */
export function checkCompat(ours: SchemaMeta, theirs: SchemaMeta): CompatResult {
  if (
    !Number.isInteger(theirs.wireVersion) ||
    !Number.isInteger(theirs.minCompat) ||
    theirs.wireVersion < 1 ||
    theirs.minCompat < 1 ||
    theirs.minCompat > theirs.wireVersion
  ) {
    return {
      ok: false,
      code: "invalid_meta",
      message: `Stored taskora wire-format meta is corrupt or was written by a non-taskora client (wireVersion=${theirs.wireVersion}, minCompat=${theirs.minCompat}). Either point taskora at an empty Redis keyspace or fix the meta record manually.`,
    };
  }

  if (theirs.wireVersion < ours.minCompat) {
    return {
      ok: false,
      code: "theirs_too_old",
      message:
        `Storage backend was written by taskora wireVersion=${theirs.wireVersion} ` +
        `(writtenBy=${theirs.writtenBy || "unknown"}), but this process requires at least ` +
        `wireVersion=${ours.minCompat}. The persisted data layout is too old for this build.`,
    };
  }

  if (ours.wireVersion < theirs.minCompat) {
    return {
      ok: false,
      code: "theirs_too_new",
      message: `Storage backend was written by taskora wireVersion=${theirs.wireVersion} (minCompat=${theirs.minCompat}, writtenBy=${theirs.writtenBy || "unknown"}), but this process is only at wireVersion=${ours.wireVersion} — the writer did not promise backward compatibility with us. Upgrade this process, or point it at a Redis keyspace that no newer taskora has touched.`,
    };
  }

  return { ok: true };
}
