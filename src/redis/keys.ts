export function buildKeys(task: string, prefix?: string) {
  const base = prefix ? `taskora:${prefix}:{${task}}` : `taskora:{${task}}`;

  return {
    wait: `${base}:wait`,
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
