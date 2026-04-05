export function buildKeys(task: string, prefix?: string) {
  const base = prefix ? `taskora:${prefix}:{${task}}` : `taskora:{${task}}`;

  return {
    wait: `${base}:wait`,
    active: `${base}:active`,
    delayed: `${base}:delayed`,
    completed: `${base}:completed`,
    failed: `${base}:failed`,
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
