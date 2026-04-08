import type { Taskora } from "../types.js";
import type { RedisDriver } from "./driver.js";
import { EventReader } from "./event-reader.js";
import { JobWaiter } from "./job-waiter.js";
import { buildKeys, buildScheduleKeys } from "./keys.js";
import * as scripts from "./scripts.js";
import * as wfScripts from "./workflow-scripts.js";

const SCRIPT_MAP: Record<string, string> = {
  enqueue: scripts.ENQUEUE,
  enqueueDelayed: scripts.ENQUEUE_DELAYED,
  moveToActive: scripts.MOVE_TO_ACTIVE,
  ack: scripts.ACK,
  fail: scripts.FAIL,
  nack: scripts.NACK,
  stalledCheck: scripts.STALLED_CHECK,
  extendLock: scripts.EXTEND_LOCK,
  tickScheduler: scripts.TICK_SCHEDULER,
  acquireSchedulerLock: scripts.ACQUIRE_SCHEDULER_LOCK,
  renewSchedulerLock: scripts.RENEW_SCHEDULER_LOCK,
  versionDistribution: scripts.VERSION_DISTRIBUTION,
  listJobDetails: scripts.LIST_JOB_DETAILS,
  retryDLQ: scripts.RETRY_DLQ,
  retryAllDLQ: scripts.RETRY_ALL_DLQ,
  trimDLQ: scripts.TRIM_DLQ,
  debounce: scripts.DEBOUNCE,
  throttleEnqueue: scripts.THROTTLE_ENQUEUE,
  deduplicateEnqueue: scripts.DEDUPLICATE_ENQUEUE,
  collectPush: scripts.COLLECT_PUSH,
  cancel: scripts.CANCEL,
  finishCancel: scripts.FINISH_CANCEL,
  createWorkflow: wfScripts.CREATE_WORKFLOW,
  advanceWorkflow: wfScripts.ADVANCE_WORKFLOW,
  failWorkflow: wfScripts.FAIL_WORKFLOW,
  cancelWorkflow: wfScripts.CANCEL_WORKFLOW,
  cleanJobs: scripts.CLEAN_JOBS,
};

export class RedisBackend implements Taskora.Adapter {
  private driver: RedisDriver;
  private ownsDriver: boolean;
  private prefix?: string;
  private shas = new Map<string, string>();
  private jobWaiter: JobWaiter | null = null;
  private blockingClients = new Map<string, RedisDriver>();
  private connected = false;

  constructor(options: { driver: RedisDriver; ownsDriver: boolean; prefix?: string }) {
    this.driver = options.driver;
    this.ownsDriver = options.ownsDriver;
    this.prefix = options.prefix;
  }

  async connect(): Promise<void> {
    await this.driver.connect();
    this.connected = true;
    await this.loadScripts();
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    // Blocking clients are stuck in BZPOPMIN — must force-disconnect, NOT
    // graceful close, or shutdown hangs up to the full block timeout.
    for (const client of this.blockingClients.values()) {
      await client.disconnect();
    }
    this.blockingClients.clear();
    if (this.jobWaiter) {
      await this.jobWaiter.shutdown();
      this.jobWaiter = null;
    }
    if (this.ownsDriver) {
      await this.driver.close();
    }
  }

  async enqueue(
    task: string,
    jobId: string,
    data: string,
    options: {
      _v: number;
      maxAttempts?: number;
      expireAt?: number;
      concurrencyKey?: string;
      concurrencyLimit?: number;
    } & Taskora.JobOptions,
  ): Promise<void> {
    const keys = buildKeys(task, this.prefix);
    const now = String(Date.now());
    const maxAttempts = String(options.maxAttempts ?? 1);
    const expireAt = String(options.expireAt ?? 0);
    const concurrencyKey = options.concurrencyKey ?? "";
    const concurrencyLimit = String(options.concurrencyLimit ?? 0);

    if (options.delay && options.delay > 0) {
      await this.eval(
        "enqueueDelayed",
        3,
        keys.delayed,
        keys.events,
        keys.marker,
        keys.jobPrefix,
        jobId,
        data,
        now,
        String(options._v),
        String(options.delay),
        String(options.priority ?? 0),
        maxAttempts,
        expireAt,
        concurrencyKey,
        concurrencyLimit,
      );
      return;
    }

    await this.eval(
      "enqueue",
      3,
      keys.wait,
      keys.events,
      keys.marker,
      keys.jobPrefix,
      jobId,
      data,
      now,
      String(options._v),
      String(options.priority ?? 0),
      maxAttempts,
      expireAt,
      concurrencyKey,
      concurrencyLimit,
      (options as { _wf?: string })._wf ?? "",
      String((options as { _wfNode?: number })._wfNode ?? ""),
    );
  }

  async debounceEnqueue(
    task: string,
    jobId: string,
    data: string,
    options: {
      _v: number;
      maxAttempts?: number;
      priority?: number;
      expireAt?: number;
      concurrencyKey?: string;
      concurrencyLimit?: number;
    },
    debounceKey: string,
    delayMs: number,
  ): Promise<void> {
    const keys = buildKeys(task, this.prefix);
    const base = this.prefix ? `taskora:${this.prefix}:{${task}}` : `taskora:{${task}}`;
    const fullDebounceKey = `${base}:debounce:${debounceKey}`;

    await this.eval(
      "debounce",
      3,
      keys.delayed,
      keys.events,
      keys.marker,
      keys.jobPrefix,
      jobId,
      data,
      String(Date.now()),
      String(options._v),
      String(delayMs),
      String(options.priority ?? 0),
      String(options.maxAttempts ?? 1),
      fullDebounceKey,
      String(options.expireAt ?? 0),
      options.concurrencyKey ?? "",
      String(options.concurrencyLimit ?? 0),
    );
  }

  async throttleEnqueue(
    task: string,
    jobId: string,
    data: string,
    options: {
      _v: number;
      maxAttempts?: number;
      delay?: number;
      priority?: number;
      expireAt?: number;
      concurrencyKey?: string;
      concurrencyLimit?: number;
    },
    throttleKey: string,
    max: number,
    windowMs: number,
  ): Promise<boolean> {
    const keys = buildKeys(task, this.prefix);
    const base = this.prefix ? `taskora:${this.prefix}:{${task}}` : `taskora:{${task}}`;
    const fullThrottleKey = `${base}:throttle:${throttleKey}`;

    const result = await this.eval(
      "throttleEnqueue",
      4,
      keys.wait,
      keys.delayed,
      keys.events,
      keys.marker,
      keys.jobPrefix,
      jobId,
      data,
      String(Date.now()),
      String(options._v),
      String(options.priority ?? 0),
      String(options.maxAttempts ?? 1),
      fullThrottleKey,
      String(max),
      String(windowMs),
      String(options.delay ?? 0),
      String(options.expireAt ?? 0),
      options.concurrencyKey ?? "",
      String(options.concurrencyLimit ?? 0),
    );
    return result === 1;
  }

  async deduplicateEnqueue(
    task: string,
    jobId: string,
    data: string,
    options: {
      _v: number;
      maxAttempts?: number;
      delay?: number;
      priority?: number;
      expireAt?: number;
      concurrencyKey?: string;
      concurrencyLimit?: number;
    },
    dedupKey: string,
    states: string[],
  ): Promise<{ created: true } | { created: false; existingId: string }> {
    const keys = buildKeys(task, this.prefix);
    const base = this.prefix ? `taskora:${this.prefix}:{${task}}` : `taskora:{${task}}`;
    const fullDedupKey = `${base}:dedup:${dedupKey}`;

    const result = (await this.eval(
      "deduplicateEnqueue",
      4,
      keys.wait,
      keys.delayed,
      keys.events,
      keys.marker,
      keys.jobPrefix,
      jobId,
      data,
      String(Date.now()),
      String(options._v),
      String(options.priority ?? 0),
      String(options.maxAttempts ?? 1),
      fullDedupKey,
      String(options.delay ?? 0),
      String(options.expireAt ?? 0),
      options.concurrencyKey ?? "",
      String(options.concurrencyLimit ?? 0),
      ...states,
    )) as [number, string?];

    if (result[0] === 0) {
      return { created: false, existingId: result[1] as string };
    }
    return { created: true };
  }

  async collectPush(
    task: string,
    jobId: string,
    item: string,
    options: {
      _v: number;
      maxAttempts?: number;
      collectKey: string;
      delayMs: number;
      maxSize: number;
      maxWaitMs: number;
    },
  ): Promise<{ flushed: boolean; count: number }> {
    const keys = buildKeys(task, this.prefix);

    const result = (await this.eval(
      "collectPush",
      4,
      keys.delayed,
      keys.events,
      keys.marker,
      keys.wait,
      keys.jobPrefix,
      jobId,
      item,
      String(Date.now()),
      String(options._v),
      String(options.delayMs),
      String(options.maxSize),
      String(options.maxWaitMs),
      options.collectKey,
      String(options.maxAttempts ?? 1),
    )) as [number, number];

    return { flushed: result[0] === 1, count: result[1] };
  }

  async dequeue(
    task: string,
    lockTtl: number,
    token: string,
    options?: Taskora.DequeueOptions,
  ): Promise<Taskora.DequeueResult | null> {
    const keys = buildKeys(task, this.prefix);

    const result = await this.eval(
      "moveToActive",
      6,
      keys.wait,
      keys.active,
      keys.delayed,
      keys.events,
      keys.marker,
      keys.expired,
      keys.jobPrefix,
      String(lockTtl),
      token,
      String(Date.now()),
      options?.onExpire ?? "fail",
      options?.singleton ? "1" : "0",
    );

    if (!result) return null;

    const [id, data, _v, attempt, ts] = result as [string, string, string, string, string];
    return {
      id,
      data,
      _v: Number(_v),
      attempt: Number(attempt),
      timestamp: Number(ts),
    };
  }

  async blockingDequeue(
    task: string,
    lockTtl: number,
    token: string,
    timeoutMs: number,
    options?: Taskora.DequeueOptions,
  ): Promise<Taskora.DequeueResult | null> {
    const keys = buildKeys(task, this.prefix);

    // Fast path: try non-blocking moveToActive first
    const quick = await this.dequeue(task, lockTtl, token, options);
    if (quick) return quick;

    const blockClient = await this.getBlockingClient(task);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const remaining = Math.max(0, deadline - Date.now());
      if (remaining <= 0) return null;

      const blockSec = Math.min(remaining, 2000) / 1000;
      let popped: [string, string, string] | null = null;

      try {
        popped = await blockClient.blockingZPopMin(keys.marker, blockSec);
      } catch {
        return null; // connection interrupted (shutdown)
      }

      if (popped) {
        const score = Number(popped[2]);
        const now = Date.now();

        if (score > now) {
          // Delayed marker — wait until due or new marker
          const waitMs = Math.min(score - now, Math.max(0, deadline - now));
          if (waitMs > 0) {
            try {
              await blockClient.blockingZPopMin(keys.marker, waitMs / 1000);
            } catch {
              return null;
            }
          }
        }
      }

      // Try moveToActive (promotes delayed + dequeues)
      const result = await this.dequeue(task, lockTtl, token, options);
      if (result) return result;
    }

    return null;
  }

  private async getBlockingClient(task: string): Promise<RedisDriver> {
    let client = this.blockingClients.get(task);
    if (!client) {
      client = await this.driver.duplicate();
      this.blockingClients.set(task, client);
    }
    return client;
  }

  async ack(task: string, jobId: string, token: string, result: string): Promise<void> {
    const keys = buildKeys(task, this.prefix);
    await this.eval(
      "ack",
      4,
      keys.active,
      keys.completed,
      keys.events,
      keys.marker,
      keys.jobPrefix,
      jobId,
      token,
      result,
      String(Date.now()),
    );
    // Throughput counter — outside Lua to avoid hash tag issues
    this.incrMetric(task, "completed");
  }

  async fail(
    task: string,
    jobId: string,
    token: string,
    error: string,
    retry?: { delay: number },
  ): Promise<void> {
    const keys = buildKeys(task, this.prefix);
    await this.eval(
      "fail",
      5,
      keys.active,
      keys.failed,
      keys.events,
      keys.delayed,
      keys.marker,
      keys.jobPrefix,
      jobId,
      token,
      error,
      String(Date.now()),
      String(retry ? retry.delay : -1),
    );
    // Only count permanent failures, not retries
    if (!retry) this.incrMetric(task, "failed");
  }

  private incrMetric(task: string, type: string): void {
    const base = this.prefix ? `taskora:${this.prefix}` : "taskora";
    const bucket = Math.floor(Date.now() / 60000) * 60000;
    const key = `${base}:metrics:${task}:${type}:${bucket}`;
    // Fire-and-forget — failures are non-critical (metrics are best-effort).
    this.driver
      .command("incr", [key])
      .then(() => this.driver.command("expire", [key, 86400]))
      .catch(() => {});
  }

  async nack(task: string, jobId: string, token: string): Promise<void> {
    const keys = buildKeys(task, this.prefix);
    await this.eval(
      "nack",
      4,
      keys.active,
      keys.wait,
      keys.events,
      keys.marker,
      keys.jobPrefix,
      jobId,
      token,
    );
  }

  async setProgress(task: string, jobId: string, value: string): Promise<void> {
    const keys = buildKeys(task, this.prefix);
    await this.driver.command("hset", [`${keys.jobPrefix}${jobId}`, "progress", value]);
    await this.driver.command("xadd", [
      keys.events,
      "MAXLEN",
      "~",
      "10000",
      "*",
      "event",
      "progress",
      "jobId",
      jobId,
      "value",
      value,
    ]);
  }

  async addLog(task: string, jobId: string, entry: string): Promise<void> {
    const keys = buildKeys(task, this.prefix);
    await this.driver.command("rpush", [`${keys.jobPrefix}${jobId}:logs`, entry]);
  }

  async getState(task: string, jobId: string): Promise<Taskora.JobState | null> {
    const keys = buildKeys(task, this.prefix);
    const state = (await this.driver.command("hget", [
      `${keys.jobPrefix}${jobId}`,
      "state",
    ])) as string | null;
    return (state as Taskora.JobState) ?? null;
  }

  async getResult(task: string, jobId: string): Promise<string | null> {
    const keys = buildKeys(task, this.prefix);
    return (await this.driver.command("get", [`${keys.jobPrefix}${jobId}:result`])) as
      | string
      | null;
  }

  async getError(task: string, jobId: string): Promise<string | null> {
    const keys = buildKeys(task, this.prefix);
    return (await this.driver.command("hget", [
      `${keys.jobPrefix}${jobId}`,
      "error",
    ])) as string | null;
  }

  async getProgress(task: string, jobId: string): Promise<string | null> {
    const keys = buildKeys(task, this.prefix);
    return (await this.driver.command("hget", [
      `${keys.jobPrefix}${jobId}`,
      "progress",
    ])) as string | null;
  }

  async getLogs(task: string, jobId: string): Promise<string[]> {
    const keys = buildKeys(task, this.prefix);
    return (await this.driver.command("lrange", [
      `${keys.jobPrefix}${jobId}:logs`,
      0,
      -1,
    ])) as string[];
  }

  async subscribe(
    tasks: string[],
    handler: (event: Taskora.StreamEvent) => void,
  ): Promise<() => Promise<void>> {
    const subDriver = await this.driver.duplicate();

    const reader = new EventReader(subDriver, this.prefix);
    await reader.start(tasks, handler);

    return async () => {
      await reader.stop();
      // Force-disconnect: the reader may be mid-XREAD-BLOCK, and a graceful
      // close() would wait for it to time out.
      try {
        await subDriver.disconnect();
      } catch {
        // Already disconnected by reader.stop()
      }
    };
  }

  async awaitJob(
    task: string,
    jobId: string,
    timeoutMs?: number,
  ): Promise<Taskora.AwaitJobResult | null> {
    if (!this.jobWaiter) {
      this.jobWaiter = new JobWaiter(this.driver, this.prefix);
    }
    return this.jobWaiter.wait(task, jobId, timeoutMs);
  }

  async stalledCheck(
    task: string,
    maxStalledCount: number,
  ): Promise<{ recovered: string[]; failed: string[] }> {
    const keys = buildKeys(task, this.prefix);
    const result = (await this.eval(
      "stalledCheck",
      7,
      keys.stalled,
      keys.active,
      keys.wait,
      keys.failed,
      keys.events,
      keys.marker,
      keys.cancelled,
      keys.jobPrefix,
      String(maxStalledCount),
      String(Date.now()),
    )) as (string | number)[];

    const recovered: string[] = [];
    const failed: string[] = [];

    let idx = 0;
    const recoveredCount = Number(result[idx++]);
    for (let i = 0; i < recoveredCount; i++) {
      recovered.push(String(result[idx++]));
    }
    const failedCount = Number(result[idx++]);
    for (let i = 0; i < failedCount; i++) {
      failed.push(String(result[idx++]));
    }

    return { recovered, failed };
  }

  async getVersionDistribution(task: string): Promise<{
    waiting: Record<number, number>;
    active: Record<number, number>;
    delayed: Record<number, number>;
  }> {
    const keys = buildKeys(task, this.prefix);
    const result = (await this.eval(
      "versionDistribution",
      3,
      keys.wait,
      keys.active,
      keys.delayed,
      keys.jobPrefix,
    )) as string[];

    const distribution: {
      waiting: Record<number, number>;
      active: Record<number, number>;
      delayed: Record<number, number>;
    } = { waiting: {}, active: {}, delayed: {} };

    let i = 0;
    while (i < result.length) {
      const section = result[i++] as "waiting" | "active" | "delayed";
      const bucket = distribution[section];
      while (i < result.length && result[i] !== "END") {
        const version = Number(result[i++]);
        const count = Number(result[i++]);
        bucket[version] = count;
      }
      i++; // skip "END"
    }

    return distribution;
  }

  // ── Inspector ──────────────────────────────────────────────────────

  private static readonly DETAIL_FIELDS = [
    "ts",
    "_v",
    "attempt",
    "state",
    "processedOn",
    "finishedOn",
    "error",
    "progress",
  ] as const;

  private static readonly STATE_MODE: Record<
    string,
    {
      key: "wait" | "active" | "delayed" | "completed" | "failed" | "expired" | "cancelled";
      mode: string;
    }
  > = {
    waiting: { key: "wait", mode: "lrange" },
    active: { key: "active", mode: "lrange" },
    delayed: { key: "delayed", mode: "zrange" },
    completed: { key: "completed", mode: "zrevrange" },
    failed: { key: "failed", mode: "zrevrange" },
    expired: { key: "expired", mode: "zrevrange" },
    cancelled: { key: "cancelled", mode: "zrevrange" },
  };

  async listJobDetails(
    task: string,
    state: "waiting" | "active" | "delayed" | "completed" | "failed" | "expired" | "cancelled",
    offset: number,
    limit: number,
  ): Promise<Array<{ id: string; details: Taskora.RawJobDetails }>> {
    const keys = buildKeys(task, this.prefix);
    const { key, mode } = RedisBackend.STATE_MODE[state];

    const raw = (await this.eval(
      "listJobDetails",
      1,
      keys[key],
      keys.jobPrefix,
      String(offset),
      String(limit),
      mode,
    )) as Array<Array<string | null>>;

    if (!raw || raw.length === 0) return [];

    // Parse Lua response: each entry = [id, ts, _v, attempt, state,
    //   processedOn, finishedOn, error, progress, data, result, numLogs, ...logs]
    const FIELDS = RedisBackend.DETAIL_FIELDS;
    return raw.map((entry) => {
      const id = entry[0] as string;
      const fields: Record<string, string> = {};
      for (let i = 0; i < FIELDS.length; i++) {
        const val = entry[1 + i];
        if (val) fields[FIELDS[i]] = val;
      }
      const numLogs = Number(entry[11] ?? 0);
      const logs = entry.slice(12, 12 + numLogs) as string[];

      return {
        id,
        details: {
          fields,
          data: entry[9] || null,
          result: entry[10] || null,
          logs,
        },
      };
    });
  }

  async getJobDetails(task: string, jobId: string): Promise<Taskora.RawJobDetails | null> {
    const keys = buildKeys(task, this.prefix);
    const jobKey = `${keys.jobPrefix}${jobId}`;

    const results = await this.driver
      .pipeline()
      .add("hgetall", [jobKey])
      .add("get", [`${jobKey}:data`])
      .add("get", [`${jobKey}:result`])
      .add("lrange", [`${jobKey}:logs`, 0, -1])
      .exec();
    const fields = results[0][1] as Record<string, string>;

    if (!fields || Object.keys(fields).length === 0) return null;

    return {
      fields,
      data: results[1][1] as string | null,
      result: results[2][1] as string | null,
      logs: results[3][1] as string[],
    };
  }

  async getQueueStats(task: string): Promise<Taskora.QueueStats> {
    const keys = buildKeys(task, this.prefix);

    const results = await this.driver
      .pipeline()
      .add("llen", [keys.wait])
      .add("llen", [keys.active])
      .add("zcard", [keys.delayed])
      .add("zcard", [keys.completed])
      .add("zcard", [keys.failed])
      .add("zcard", [keys.expired])
      .add("zcard", [keys.cancelled])
      .exec();
    return {
      waiting: results[0][1] as number,
      active: results[1][1] as number,
      delayed: results[2][1] as number,
      completed: results[3][1] as number,
      failed: results[4][1] as number,
      expired: results[5][1] as number,
      cancelled: results[6][1] as number,
    };
  }

  // ── Dead letter queue ─────────────────────────────────────────────

  async retryFromDLQ(task: string, jobId: string): Promise<boolean> {
    const keys = buildKeys(task, this.prefix);
    const result = await this.eval(
      "retryDLQ",
      4,
      keys.failed,
      keys.wait,
      keys.events,
      keys.marker,
      keys.jobPrefix,
      jobId,
    );
    return result === 1;
  }

  async retryAllFromDLQ(task: string, limit: number): Promise<number> {
    const keys = buildKeys(task, this.prefix);
    const result = await this.eval(
      "retryAllDLQ",
      4,
      keys.failed,
      keys.wait,
      keys.events,
      keys.marker,
      keys.jobPrefix,
      String(limit),
    );
    return result as number;
  }

  async trimDLQ(task: string, before: number, maxItems: number): Promise<number> {
    const keys = buildKeys(task, this.prefix);
    const result = await this.eval(
      "trimDLQ",
      1,
      keys.failed,
      keys.jobPrefix,
      String(before),
      String(maxItems),
    );
    return result as number;
  }

  async trimCompleted(task: string, before: number, maxItems: number): Promise<number> {
    const keys = buildKeys(task, this.prefix);
    const result = await this.eval(
      "trimDLQ",
      1,
      keys.completed,
      keys.jobPrefix,
      String(before),
      String(maxItems),
    );
    return result as number;
  }

  // ── Scheduling ──────────────────────────────────────────────────────

  async addSchedule(name: string, config: string, nextRun: number): Promise<void> {
    const keys = buildScheduleKeys(this.prefix);
    await this.driver
      .pipeline()
      .add("hset", [keys.schedules, name, config])
      .add("zadd", [keys.schedulesNext, String(nextRun), name])
      .exec();
  }

  async removeSchedule(name: string): Promise<void> {
    const keys = buildScheduleKeys(this.prefix);
    await this.driver
      .pipeline()
      .add("hdel", [keys.schedules, name])
      .add("zrem", [keys.schedulesNext, name])
      .exec();
  }

  async getSchedule(
    name: string,
  ): Promise<{ config: string; nextRun: number | null; paused: boolean } | null> {
    const keys = buildScheduleKeys(this.prefix);
    const results = await this.driver
      .pipeline()
      .add("hget", [keys.schedules, name])
      .add("zscore", [keys.schedulesNext, name])
      .exec();
    const config = results[0][1] as string | null;
    const score = results[1][1] as string | null;

    if (!config) return null;

    return {
      config,
      nextRun: score !== null ? Number(score) : null,
      paused: score === null,
    };
  }

  async listSchedules(): Promise<Taskora.ScheduleRecord[]> {
    const keys = buildScheduleKeys(this.prefix);
    const [all, scores] = await Promise.all([
      this.driver.command("hgetall", [keys.schedules]) as Promise<Record<string, string>>,
      this.driver.command("zrange", [keys.schedulesNext, 0, -1, "WITHSCORES"]) as Promise<string[]>,
    ]);

    const scoreMap = new Map<string, number>();
    for (let i = 0; i < scores.length; i += 2) {
      scoreMap.set(scores[i], Number(scores[i + 1]));
    }

    return Object.entries(all).map(([name, config]) => ({
      name,
      config,
      nextRun: scoreMap.get(name) ?? null,
    }));
  }

  async tickScheduler(now: number): Promise<Array<{ name: string; config: string }>> {
    const keys = buildScheduleKeys(this.prefix);
    const result = (await this.eval(
      "tickScheduler",
      2,
      keys.schedulesNext,
      keys.schedules,
      String(now),
    )) as string[];

    const schedules: Array<{ name: string; config: string }> = [];
    for (let i = 0; i < result.length; i += 2) {
      schedules.push({ name: result[i], config: result[i + 1] });
    }
    return schedules;
  }

  async updateScheduleNextRun(name: string, config: string, nextRun: number): Promise<void> {
    const keys = buildScheduleKeys(this.prefix);
    await this.driver
      .pipeline()
      .add("hset", [keys.schedules, name, config])
      .add("zadd", [keys.schedulesNext, String(nextRun), name])
      .exec();
  }

  async pauseSchedule(name: string): Promise<void> {
    const keys = buildScheduleKeys(this.prefix);
    await this.driver.command("zrem", [keys.schedulesNext, name]);
  }

  async resumeSchedule(name: string, nextRun: number): Promise<void> {
    const keys = buildScheduleKeys(this.prefix);
    await this.driver.command("zadd", [keys.schedulesNext, String(nextRun), name]);
  }

  async acquireSchedulerLock(token: string, ttl: number): Promise<boolean> {
    const keys = buildScheduleKeys(this.prefix);
    const result = await this.eval(
      "acquireSchedulerLock",
      1,
      keys.schedulerLock,
      token,
      String(ttl),
    );
    return result === 1;
  }

  async renewSchedulerLock(token: string, ttl: number): Promise<boolean> {
    const keys = buildScheduleKeys(this.prefix);
    const result = await this.eval("renewSchedulerLock", 1, keys.schedulerLock, token, String(ttl));
    return result === 1;
  }

  async extendLock(
    task: string,
    jobId: string,
    token: string,
    ttl: number,
  ): Promise<"extended" | "lost" | "cancelled"> {
    const keys = buildKeys(task, this.prefix);
    const result = await this.eval(
      "extendLock",
      1,
      keys.stalled,
      keys.jobPrefix,
      jobId,
      token,
      String(ttl),
    );
    if (result === -1) return "cancelled";
    if (result === 1) return "extended";
    return "lost";
  }

  async cancel(
    task: string,
    jobId: string,
    reason?: string,
  ): Promise<"cancelled" | "flagged" | "not_cancellable"> {
    const keys = buildKeys(task, this.prefix);
    const result = await this.eval(
      "cancel",
      6,
      keys.wait,
      keys.delayed,
      keys.cancelled,
      keys.events,
      keys.marker,
      keys.cancelChannel,
      keys.jobPrefix,
      jobId,
      reason ?? "",
      String(Date.now()),
    );
    if (result === 1) return "cancelled";
    if (result === 2) return "flagged";
    return "not_cancellable";
  }

  async onCancel(task: string, handler: (jobId: string) => void): Promise<() => void> {
    const keys = buildKeys(task, this.prefix);
    const subDriver = await this.driver.duplicate();
    const unsubscribe = await subDriver.subscribe(keys.cancelChannel, (message) => {
      handler(message);
    });
    return () => {
      // Fire-and-forget cleanup — callers don't await this and it's safe to detach.
      // Force-disconnect: in ioredis, once a client enters subscriber mode, `quit()`
      // sometimes hangs; `disconnect(false)` is reliable.
      unsubscribe()
        .then(() => subDriver.disconnect())
        .catch(() => {});
    };
  }

  async finishCancel(task: string, jobId: string, token: string): Promise<void> {
    const keys = buildKeys(task, this.prefix);
    await this.eval(
      "finishCancel",
      4,
      keys.active,
      keys.cancelled,
      keys.events,
      keys.marker,
      keys.jobPrefix,
      jobId,
      token,
      String(Date.now()),
    );
  }

  // ── Workflows (atomic Lua scripts) ──

  private wfKey(workflowId: string): string {
    const base = this.prefix ? `taskora:${this.prefix}` : "taskora";
    return `${base}:wf:{${workflowId}}`;
  }

  async createWorkflow(workflowId: string, graph: string): Promise<void> {
    const parsed = JSON.parse(graph);
    await this.eval(
      "createWorkflow",
      1,
      this.wfKey(workflowId),
      graph,
      String(Date.now()),
      String(parsed.nodes.length),
    );
  }

  async advanceWorkflow(
    workflowId: string,
    nodeIndex: number,
    result: string,
  ): Promise<Taskora.WorkflowAdvanceResult> {
    const raw = (await this.eval(
      "advanceWorkflow",
      1,
      this.wfKey(workflowId),
      String(nodeIndex),
      result,
    )) as string;
    const parsed = JSON.parse(raw);
    // cjson encodes empty Lua tables as {} (object), normalize to []
    if (!Array.isArray(parsed.toDispatch)) parsed.toDispatch = [];
    return parsed;
  }

  async failWorkflow(
    workflowId: string,
    nodeIndex: number,
    error: string,
  ): Promise<Taskora.WorkflowFailResult> {
    const raw = (await this.eval(
      "failWorkflow",
      1,
      this.wfKey(workflowId),
      String(nodeIndex),
      error,
    )) as string;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.activeJobIds)) parsed.activeJobIds = [];
    return parsed;
  }

  async getWorkflowState(workflowId: string): Promise<string | null> {
    const key = this.wfKey(workflowId);
    const [state, result, error] = (await this.driver.command("hmget", [
      key,
      "state",
      "result",
      "error",
    ])) as (string | null)[];
    if (!state) return null;
    return JSON.stringify({ state, result: result ?? undefined, error: error ?? undefined });
  }

  async cancelWorkflow(workflowId: string, reason?: string): Promise<Taskora.WorkflowCancelResult> {
    const raw = (await this.eval(
      "cancelWorkflow",
      1,
      this.wfKey(workflowId),
      reason ?? "",
    )) as string;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.activeJobIds)) parsed.activeJobIds = [];
    return parsed;
  }

  async getWorkflowMeta(
    task: string,
    jobId: string,
  ): Promise<{ workflowId: string; nodeIndex: number } | null> {
    const keys = buildKeys(task, this.prefix);
    const jobKey = keys.jobPrefix + jobId;
    const [wf, wfNode] = (await this.driver.command("hmget", [
      jobKey,
      "_wf",
      "_wfNode",
    ])) as (string | null)[];
    if (!wf) return null;
    return { workflowId: wf, nodeIndex: Number(wfNode ?? 0) };
  }

  // ── Board / observability ──────────────────────────────────────────

  async cleanJobs(
    task: string,
    state: Taskora.JobState,
    before: number,
    limit: number,
  ): Promise<number> {
    const keys = buildKeys(task, this.prefix);
    const stateMap: Record<string, string> = {
      completed: keys.completed,
      failed: keys.failed,
      expired: keys.expired,
      cancelled: keys.cancelled,
    };
    const setKey = stateMap[state];
    if (!setKey) return 0;

    const result = await this.eval(
      "cleanJobs",
      1,
      setKey,
      keys.jobPrefix,
      String(before),
      String(limit),
    );
    return result as number;
  }

  async getServerInfo(): Promise<{
    version: string;
    usedMemory: string;
    usedMemoryBytes: number;
    peakMemory: string;
    uptime: number;
    connected: boolean;
    dbSize: number;
    connectedClients: number;
  }> {
    const [serverInfo, memInfo, clientInfo, dbSize] = (await Promise.all([
      this.driver.command("info", ["server"]),
      this.driver.command("info", ["memory"]),
      this.driver.command("info", ["clients"]),
      this.driver.command("dbsize", []),
    ])) as [string, string, string, number];

    const match = (text: string, key: string) => {
      const m = text.match(new RegExp(`${key}:(.+)`));
      return m?.[1]?.trim() ?? "";
    };

    return {
      version: match(serverInfo, "redis_version") || "unknown",
      usedMemory: match(memInfo, "used_memory_human") || "0B",
      usedMemoryBytes: Number(match(memInfo, "used_memory")) || 0,
      peakMemory: match(memInfo, "used_memory_peak_human") || "0B",
      uptime: Number(match(serverInfo, "uptime_in_seconds")) || 0,
      connected: this.connected,
      dbSize,
      connectedClients: Number(match(clientInfo, "connected_clients")) || 0,
    };
  }

  async listWorkflows(
    state?: Taskora.WorkflowState,
    offset = 0,
    limit = 20,
  ): Promise<
    Array<{
      id: string;
      state: Taskora.WorkflowState;
      createdAt: number;
      nodeCount: number;
      name: string | null;
      tasks: string[];
    }>
  > {
    const base = this.prefix ? `taskora:${this.prefix}` : "taskora";
    const pattern = `${base}:wf:{*}`;
    const results: Array<{
      id: string;
      state: Taskora.WorkflowState;
      createdAt: number;
      nodeCount: number;
      name: string | null;
      tasks: string[];
    }> = [];

    let cursor = "0";
    const collected: string[] = [];

    do {
      const [next, keys] = (await this.driver.command("scan", [
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        200,
      ])) as [string, string[]];
      cursor = next;
      collected.push(...keys);
    } while (cursor !== "0");

    const pipe = this.driver.pipeline();
    for (const key of collected) {
      pipe.add("hmget", [key, "state", "createdAt", "graph"]);
    }
    const pipeResults = (await pipe.exec()) as [Error | null, (string | null)[]][];

    for (let i = 0; i < collected.length; i++) {
      const [, values] = pipeResults[i];
      const wfState = values[0] as Taskora.WorkflowState | null;
      if (!wfState) continue;
      if (state && wfState !== state) continue;

      const key = collected[i];
      const idMatch = key.match(/wf:\{(.+)\}$/);
      const id = idMatch?.[1] ?? key;

      let nodeCount = 0;
      let name: string | null = null;
      const tasks: string[] = [];
      if (values[2]) {
        try {
          const graph = JSON.parse(values[2]);
          nodeCount = graph.nodes?.length ?? 0;
          name = graph.name ?? null;
          // Collect unique task names in order
          const seen = new Set<string>();
          for (const node of graph.nodes ?? []) {
            if (!seen.has(node.taskName)) {
              seen.add(node.taskName);
              tasks.push(node.taskName);
            }
          }
        } catch {
          // ignore parse errors
        }
      }

      results.push({ id, state: wfState, createdAt: Number(values[1] ?? 0), nodeCount, name, tasks });
    }

    results.sort((a, b) => b.createdAt - a.createdAt);
    return results.slice(offset, offset + limit);
  }

  async getWorkflowDetail(workflowId: string): Promise<Taskora.WorkflowDetail | null> {
    const key = this.wfKey(workflowId);
    const raw = (await this.driver.command("hgetall", [key])) as Record<string, string>;
    if (!raw || !raw.state) return null;

    let graph: Taskora.WorkflowDetail["graph"] = { nodes: [], terminal: [] };
    try {
      graph = JSON.parse(raw.graph);
    } catch {
      // ignore
    }

    const nodes: Taskora.WorkflowDetail["nodes"] = [];
    for (let i = 0; i < graph.nodes.length; i++) {
      nodes.push({
        index: i,
        state: raw[`n:${i}:state`] ?? "pending",
        result: raw[`n:${i}:result`] ?? null,
        error: raw[`n:${i}:error`] ?? null,
        jobId: graph.nodes[i].jobId,
      });
    }

    return {
      id: workflowId,
      state: raw.state as Taskora.WorkflowState,
      createdAt: Number(raw.createdAt ?? 0),
      graph,
      nodes,
      result: raw.result ?? null,
      error: raw.error ?? null,
    };
  }

  async getTaskKeyStats(task: string): Promise<{ keyCount: number; memoryBytes: number }> {
    const keys = buildKeys(task, this.prefix);
    const base = this.prefix ? `taskora:${this.prefix}:{${task}}` : `taskora:{${task}}`;
    const pattern = `${base}:*`;

    // Count keys via SCAN
    let keyCount = 0;
    let cursor = "0";
    do {
      const [next, found] = (await this.driver.command("scan", [
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        500,
      ])) as [string, string[]];
      cursor = next;
      keyCount += found.length;
    } while (cursor !== "0");

    // Sum MEMORY USAGE on main structures (cheap — these are metadata keys)
    let memoryBytes = 0;
    const structKeys = [
      keys.wait, keys.active, keys.delayed,
      keys.completed, keys.failed, keys.expired,
      keys.cancelled, keys.events, keys.stalled, keys.marker,
    ];
    const pipe = this.driver.pipeline();
    for (const k of structKeys) {
      pipe.add("memory", ["USAGE", k]);
    }
    const results = (await pipe.exec()) as [Error | null, number | null][];
    for (const [, bytes] of results) {
      if (bytes) memoryBytes += bytes;
    }

    // Sample a few job keys for memory estimate
    const sampleCursor = "0";
    const sampleKeys: string[] = [];
    const [, firstBatch] = (await this.driver.command("scan", [
      sampleCursor,
      "MATCH",
      `${base}:*`,
      "COUNT",
      20,
    ])) as [string, string[]];
    sampleKeys.push(...firstBatch.slice(0, 10));

    if (sampleKeys.length > 0) {
      const samplePipe = this.driver.pipeline();
      for (const k of sampleKeys) {
        samplePipe.add("memory", ["USAGE", k]);
      }
      const sampleResults = (await samplePipe.exec()) as [Error | null, number | null][];
      let sampleTotal = 0;
      let sampleCount = 0;
      for (const [, bytes] of sampleResults) {
        if (bytes) { sampleTotal += bytes; sampleCount++; }
      }
      if (sampleCount > 0) {
        const avgPerKey = sampleTotal / sampleCount;
        memoryBytes += Math.round(avgPerKey * Math.max(0, keyCount - structKeys.length));
      }
    }

    return { keyCount, memoryBytes };
  }

  async getThroughput(
    task: string | null,
    bucketSize: number,
    count: number,
  ): Promise<Array<{ timestamp: number; completed: number; failed: number }>> {
    const metricBase = this.prefix ? `taskora:${this.prefix}` : "taskora";
    const now = Date.now();
    const currentBucket = Math.floor(now / bucketSize) * bucketSize;
    const timestamps: number[] = [];

    for (let i = count - 1; i >= 0; i--) {
      timestamps.push(currentBucket - i * bucketSize);
    }

    if (task) {
      // Per-task: read directly
      const pipe = this.driver.pipeline();
      for (const ts of timestamps) {
        pipe.add("get", [`${metricBase}:metrics:${task}:completed:${ts}`]);
        pipe.add("get", [`${metricBase}:metrics:${task}:failed:${ts}`]);
      }
      const results = (await pipe.exec()) as [Error | null, string | null][];
      return timestamps.map((ts, i) => ({
        timestamp: ts,
        completed: Number(results[i * 2][1] ?? 0),
        failed: Number(results[i * 2 + 1][1] ?? 0),
      }));
    }

    // Aggregate across all tasks: scan for metric keys in the first bucket to discover task names
    const taskNames = new Set<string>();
    let cursor = "0";
    do {
      const [next, keys] = (await this.driver.command("scan", [
        cursor,
        "MATCH",
        `${metricBase}:metrics:*:completed:*`,
        "COUNT",
        200,
      ])) as [string, string[]];
      cursor = next;
      for (const key of keys) {
        // key format: taskora:metrics:TASK:completed:BUCKET
        const match = key.match(/metrics:(.+):completed:\d+$/);
        if (match) taskNames.add(match[1]);
      }
    } while (cursor !== "0");

    if (taskNames.size === 0) {
      return timestamps.map((ts) => ({ timestamp: ts, completed: 0, failed: 0 }));
    }

    // Pipeline all reads
    const pipe = this.driver.pipeline();
    const tasks = [...taskNames];
    for (const ts of timestamps) {
      for (const t of tasks) {
        pipe.add("get", [`${metricBase}:metrics:${t}:completed:${ts}`]);
        pipe.add("get", [`${metricBase}:metrics:${t}:failed:${ts}`]);
      }
    }
    const results = (await pipe.exec()) as [Error | null, string | null][];

    let idx = 0;
    return timestamps.map((ts) => {
      let completed = 0;
      let failed = 0;
      for (const _ of tasks) {
        completed += Number(results[idx++][1] ?? 0);
        failed += Number(results[idx++][1] ?? 0);
      }
      return { timestamp: ts, completed, failed };
    });
  }

  private async loadScripts(): Promise<void> {
    for (const [name, source] of Object.entries(SCRIPT_MAP)) {
      const sha = await this.driver.scriptLoad(source);
      this.shas.set(name, sha);
    }
  }

  private async eval(
    scriptName: string,
    numkeys: number,
    ...args: (string | number)[]
  ): Promise<unknown> {
    const sha = this.shas.get(scriptName);
    if (!sha) {
      throw new Error(`Script "${scriptName}" not loaded — call connect() first`);
    }
    // NOSCRIPT recovery is handled inside the driver.
    return this.driver.evalSha(sha, numkeys, args, SCRIPT_MAP[scriptName]);
  }
}
