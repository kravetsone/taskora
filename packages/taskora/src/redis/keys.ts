export function buildKeys(task: string, prefix?: string) {
  const base = prefix ? `taskora:${prefix}:{${task}}` : `taskora:{${task}}`;

  return {
    wait: `${base}:wait`,
    prioritized: `${base}:prioritized`,
    active: `${base}:active`,
    delayed: `${base}:delayed`,
    completed: `${base}:completed`,
    failed: `${base}:failed`,
    expired: `${base}:expired`,
    cancelled: `${base}:cancelled`,
    cancelChannel: `${base}:cancel`,
    events: `${base}:events`,
    stalled: `${base}:stalled`,
    marker: `${base}:marker`,
    jobPrefix: `${base}:`,
  };
}

export function buildScheduleKeys(prefix?: string) {
  const base = prefix ? `taskora:${prefix}` : "taskora";

  return {
    schedules: `${base}:schedules`,
    schedulesNext: `${base}:schedules:next`,
    schedulerLock: `${base}:schedules:lock`,
  };
}

/**
 * The wire-format meta hash. One key per `(redis, prefix)` pair — writing is
 * atomic via a small Lua script (see `HANDSHAKE` in `scripts.ts`).
 *
 * Not wrapped in a `{hash tag}` because it is a single-key operation and
 * never participates in a multi-key Lua script, so there is nothing to group.
 */
export function buildMetaKey(prefix?: string): string {
  return prefix ? `taskora:${prefix}:meta` : "taskora:meta";
}

/**
 * Reserved migration-coordination keys. Introduced in wireVersion=2 as
 * the standing contract for every in-place wire-format upgrade — the
 * current v1 → v2 migration uses them, and every future migration MUST
 * use them the same way.
 *
 * Contract:
 *   - `migrationLock` is a string value set with `SET NX PX` whose
 *     payload is a JSON document:
 *
 *         {
 *           "by": "taskora-wire-2",          // writer identifier
 *           "reason": "wireVersion-1-to-2",  // human-friendly label
 *           "startedAt": 1775874000000,      // ms epoch
 *           "expectedDurationMs": 60000,     // worst-case budget
 *           "targetWireVersion": 2           // halt anyone < this
 *         }
 *
 *     Any process whose own `wireVersion <= targetWireVersion` MUST halt
 *     (block handshake, deny dispatches, etc.) until the lock clears.
 *     Processes on versions strictly GREATER than `targetWireVersion`
 *     may continue — they already understand the format the migrator is
 *     producing. TTL MUST be finite and ≥ 2× `expectedDurationMs`; a
 *     crashed migrator must eventually free the cluster.
 *
 *   - `migrationChannel` is a pub/sub channel. A migrator PUBLISHes an
 *     opaque string whenever it sets or clears the lock, letting
 *     subscribed processes react immediately instead of waiting for the
 *     next poll. Payload content is intentionally unstructured — v2+
 *     processes treat any message as "re-check the lock".
 *
 * Cluster races are resolved by the lock itself: multiple v2 instances
 * starting against a v1 keyspace all try `SET NX` on the lock; exactly
 * one wins and runs the migration, the losers poll until release, then
 * re-handshake (which now reads the freshly-bumped v2 meta and takes
 * the fast path).
 *
 * Not wrapped in a `{hash tag}` because they are single-key operations
 * (SET / GET / DEL / PUBLISH) that never participate in a multi-key
 * Lua script.
 */
export function buildMigrationKeys(prefix?: string) {
  const base = prefix ? `taskora:${prefix}` : "taskora";
  return {
    migrationLock: `${base}:migration:lock`,
    migrationChannel: `${base}:migration:broadcast`,
  };
}

/**
 * The JSON payload stored in the `migrationLock` key. See
 * {@link buildMigrationKeys} for the full contract.
 */
export interface MigrationLockPayload {
  by: string;
  reason: string;
  startedAt: number;
  expectedDurationMs: number;
  targetWireVersion: number;
}
