import { randomUUID } from "node:crypto";
import type { Task } from "../task.js";
import type { Taskora } from "../types.js";
import { parseDuration } from "./duration.js";

interface SchedulerDeps {
  adapter: Taskora.Adapter;
  serializer: Taskora.Serializer;
  getTask: (name: string) => Task<unknown, unknown> | undefined;
}

interface StoredScheduleConfig {
  task: string;
  data?: unknown;
  every?: number;
  cron?: string;
  timezone?: string;
  onMissed?: Taskora.MissedPolicy;
  overlap?: boolean;
  lastJobId?: string | null;
  lastRun?: number | null;
}

interface CronParserLike {
  parse(
    expression: string,
    options?: { currentDate?: Date; tz?: string },
  ): {
    next(): { getTime(): number };
  };
}

// Lazy-loaded cron-parser module
let cronParserClass: CronParserLike | null = null;

async function getCronParser(): Promise<CronParserLike> {
  if (cronParserClass) return cronParserClass;
  try {
    const mod = await import("cron-parser");
    cronParserClass = mod.CronExpressionParser;
    return cronParserClass;
  } catch {
    throw new Error(
      '"cron-parser" is required for cron schedules — install it: bun add cron-parser',
    );
  }
}

export class Scheduler {
  private readonly deps: SchedulerDeps;
  private readonly pollInterval: number;
  private readonly lockTtl: number;
  private readonly token = randomUUID();
  private timer: ReturnType<typeof setInterval> | null = null;
  private isLeader = false;
  private stopped = false;
  private ticking = false;

  constructor(deps: SchedulerDeps, config?: Taskora.SchedulerConfig) {
    this.deps = deps;
    this.pollInterval = config?.pollInterval ?? 1_000;
    this.lockTtl = config?.lockTtl ?? 30_000;
  }

  async start(): Promise<void> {
    this.stopped = false;
    // Immediate first tick
    await this.tick();
    this.timer = setInterval(() => this.tick(), this.pollInterval);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isLeader = false;
  }

  async registerSchedule(name: string, config: Taskora.ScheduleConfig): Promise<void> {
    const stored = await this.toStoredConfig(config);
    const nextRun = await this.computeNextRun(stored, Date.now());
    await this.deps.adapter.addSchedule(name, JSON.stringify(stored), nextRun);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;

    try {
      // Try to become or remain leader
      if (this.isLeader) {
        this.isLeader = await this.deps.adapter.renewSchedulerLock(this.token, this.lockTtl);
      }
      if (!this.isLeader) {
        this.isLeader = await this.deps.adapter.acquireSchedulerLock(this.token, this.lockTtl);
      }
      if (!this.isLeader) return;

      const now = Date.now();
      const due = await this.deps.adapter.tickScheduler(now);

      for (const { name, config: configJson } of due) {
        await this.processDueSchedule(name, configJson, now);
      }
    } catch {
      // Tick errors are non-fatal — next tick will retry
    } finally {
      this.ticking = false;
    }
  }

  private async processDueSchedule(name: string, configJson: string, now: number): Promise<void> {
    const config: StoredScheduleConfig = JSON.parse(configJson);
    const task = this.deps.getTask(config.task);
    if (!task) return;

    // Overlap check: skip if previous run is still active
    if (config.overlap === false && config.lastJobId) {
      const state = await this.deps.adapter.getState(config.task, config.lastJobId);
      if (state === "active") {
        // Re-schedule for next run without dispatching
        const nextRun = await this.computeNextRun(config, now);
        await this.deps.adapter.updateScheduleNextRun(name, configJson, nextRun);
        return;
      }
    }

    // Determine how many runs to dispatch (missed run policy)
    const dispatches = await this.computeDispatches(config, now);

    let lastJobId: string | null = config.lastJobId ?? null;
    const data = config.data !== undefined ? config.data : null;
    for (const _dispatch of dispatches) {
      const handle = task.dispatch(data as never);
      lastJobId = handle.id;
    }

    // Update config with last run info and schedule next
    config.lastJobId = lastJobId;
    config.lastRun = now;
    const nextRun = await this.computeNextRun(config, now);
    await this.deps.adapter.updateScheduleNextRun(name, JSON.stringify(config), nextRun);
  }

  private async computeDispatches(config: StoredScheduleConfig, now: number): Promise<number[]> {
    const onMissed = config.onMissed ?? "skip";

    if (onMissed === "skip" || !config.lastRun) {
      return [1]; // single dispatch
    }

    const intervalMs = config.every
      ? config.every
      : config.cron
        ? await this.getCronIntervalEstimate(config, now)
        : 0;

    if (intervalMs <= 0) return [1];

    const missedCount = Math.floor((now - config.lastRun) / intervalMs);
    if (missedCount <= 1) return [1];

    if (onMissed === "catch-up") {
      return Array.from({ length: missedCount }, (_, i) => i);
    }

    // catch-up-limit:N
    const limitMatch = /^catch-up-limit:(\d+)$/.exec(onMissed);
    if (limitMatch) {
      const limit = Number(limitMatch[1]);
      const count = Math.min(missedCount, limit);
      return Array.from({ length: count }, (_, i) => i);
    }

    return [1];
  }

  private async getCronIntervalEstimate(
    config: StoredScheduleConfig,
    now: number,
  ): Promise<number> {
    if (!config.cron) return 0;
    const parser = await getCronParser();
    const options = config.timezone ? { tz: config.timezone } : undefined;
    const interval = parser.parse(config.cron, {
      currentDate: new Date(now),
      ...options,
    });
    const next1 = interval.next().getTime();
    const next2 = interval.next().getTime();
    return next2 - next1;
  }

  async computeNextRun(config: StoredScheduleConfig, fromTime: number): Promise<number> {
    if (config.every) {
      return fromTime + config.every;
    }

    if (config.cron) {
      const parser = await getCronParser();
      const options = config.timezone ? { tz: config.timezone } : undefined;
      const interval = parser.parse(config.cron, {
        currentDate: new Date(fromTime),
        ...options,
      });
      return interval.next().getTime();
    }

    throw new Error("Schedule must have either 'every' or 'cron'");
  }

  private async toStoredConfig(config: Taskora.ScheduleConfig): Promise<StoredScheduleConfig> {
    const stored: StoredScheduleConfig = {
      task: config.task,
      overlap: config.overlap ?? false,
      onMissed: config.onMissed ?? "skip",
    };

    if (config.data !== undefined) stored.data = config.data;

    if (config.every !== undefined) {
      stored.every = parseDuration(config.every);
    } else if (config.cron) {
      // Validate cron expression eagerly
      const parser = await getCronParser();
      parser.parse(config.cron);
      stored.cron = config.cron;
      if (config.timezone) stored.timezone = config.timezone;
    } else {
      throw new Error("Schedule must have either 'every' or 'cron'");
    }

    return stored;
  }
}
