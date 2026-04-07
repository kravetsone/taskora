import { Redis } from "ioredis";
import type { RedisOptions } from "ioredis";
import type { Taskora } from "../types.js";
import { EventReader } from "./event-reader.js";
import { JobWaiter } from "./job-waiter.js";
import { buildKeys, buildScheduleKeys } from "./keys.js";
import * as scripts from "./scripts.js";

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
};

export class RedisBackend implements Taskora.Adapter {
  private client: Redis;
  private ownsClient: boolean;
  private prefix?: string;
  private shas = new Map<string, string>();
  private jobWaiter: JobWaiter | null = null;
  private blockingClients = new Map<string, Redis>();

  constructor(connection: string | RedisOptions | Redis, options?: { prefix?: string }) {
    if (connection instanceof Redis) {
      this.client = connection;
      this.ownsClient = false;
    } else if (typeof connection === "string") {
      this.client = new Redis(connection, { lazyConnect: true });
      this.ownsClient = true;
    } else {
      this.client = new Redis({ ...connection, lazyConnect: true });
      this.ownsClient = true;
    }
    this.prefix = options?.prefix;
  }

  async connect(): Promise<void> {
    const { status } = this.client;
    if (status === "wait") {
      await this.client.connect();
    } else if (status !== "ready") {
      await new Promise<void>((resolve, reject) => {
        this.client.once("ready", resolve);
        this.client.once("error", reject);
      });
    }
    await this.loadScripts();
  }

  async disconnect(): Promise<void> {
    for (const client of this.blockingClients.values()) {
      client.disconnect(false);
    }
    this.blockingClients.clear();
    if (this.jobWaiter) {
      await this.jobWaiter.shutdown();
      this.jobWaiter = null;
    }
    if (this.ownsClient) {
      await this.client.quit();
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
        popped = (await blockClient.bzpopmin(keys.marker, blockSec)) as
          | [string, string, string]
          | null;
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
              await blockClient.bzpopmin(keys.marker, waitMs / 1000);
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

  private async getBlockingClient(task: string): Promise<import("ioredis").default> {
    let client = this.blockingClients.get(task);
    if (!client) {
      client = this.client.duplicate();
      await client.connect();
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
    await this.client.hset(`${keys.jobPrefix}${jobId}`, "progress", value);
    await this.client.xadd(
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
    );
  }

  async addLog(task: string, jobId: string, entry: string): Promise<void> {
    const keys = buildKeys(task, this.prefix);
    await this.client.rpush(`${keys.jobPrefix}${jobId}:logs`, entry);
  }

  async getState(task: string, jobId: string): Promise<Taskora.JobState | null> {
    const keys = buildKeys(task, this.prefix);
    const state = await this.client.hget(`${keys.jobPrefix}${jobId}`, "state");
    return (state as Taskora.JobState) ?? null;
  }

  async getResult(task: string, jobId: string): Promise<string | null> {
    const keys = buildKeys(task, this.prefix);
    return this.client.get(`${keys.jobPrefix}${jobId}:result`);
  }

  async getError(task: string, jobId: string): Promise<string | null> {
    const keys = buildKeys(task, this.prefix);
    return this.client.hget(`${keys.jobPrefix}${jobId}`, "error");
  }

  async getProgress(task: string, jobId: string): Promise<string | null> {
    const keys = buildKeys(task, this.prefix);
    return this.client.hget(`${keys.jobPrefix}${jobId}`, "progress");
  }

  async getLogs(task: string, jobId: string): Promise<string[]> {
    const keys = buildKeys(task, this.prefix);
    return this.client.lrange(`${keys.jobPrefix}${jobId}:logs`, 0, -1);
  }

  async subscribe(
    tasks: string[],
    handler: (event: Taskora.StreamEvent) => void,
  ): Promise<() => Promise<void>> {
    const subClient = this.client.duplicate();
    await subClient.connect();

    const reader = new EventReader(subClient, this.prefix);
    await reader.start(tasks, handler);

    return async () => {
      reader.stop();
      try {
        await subClient.quit();
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
      this.jobWaiter = new JobWaiter(this.client, this.prefix);
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

    const pipe = this.client.pipeline();
    pipe.hgetall(jobKey);
    pipe.get(`${jobKey}:data`);
    pipe.get(`${jobKey}:result`);
    pipe.lrange(`${jobKey}:logs`, 0, -1);

    const results = (await pipe.exec()) as [Error | null, unknown][];
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

    const pipe = this.client.pipeline();
    pipe.llen(keys.wait);
    pipe.llen(keys.active);
    pipe.zcard(keys.delayed);
    pipe.zcard(keys.completed);
    pipe.zcard(keys.failed);
    pipe.zcard(keys.expired);
    pipe.zcard(keys.cancelled);

    const results = (await pipe.exec()) as [Error | null, number][];
    return {
      waiting: results[0][1],
      active: results[1][1],
      delayed: results[2][1],
      completed: results[3][1],
      failed: results[4][1],
      expired: results[5][1],
      cancelled: results[6][1],
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
    const result = await this.eval("trimDLQ", 1, keys.failed, keys.jobPrefix, String(before), String(maxItems));
    return result as number;
  }

  async trimCompleted(task: string, before: number, maxItems: number): Promise<number> {
    const keys = buildKeys(task, this.prefix);
    const result = await this.eval("trimDLQ", 1, keys.completed, keys.jobPrefix, String(before), String(maxItems));
    return result as number;
  }

  // ── Scheduling ──────────────────────────────────────────────────────

  async addSchedule(name: string, config: string, nextRun: number): Promise<void> {
    const keys = buildScheduleKeys(this.prefix);
    await this.client
      .pipeline()
      .hset(keys.schedules, name, config)
      .zadd(keys.schedulesNext, String(nextRun), name)
      .exec();
  }

  async removeSchedule(name: string): Promise<void> {
    const keys = buildScheduleKeys(this.prefix);
    await this.client.pipeline().hdel(keys.schedules, name).zrem(keys.schedulesNext, name).exec();
  }

  async getSchedule(
    name: string,
  ): Promise<{ config: string; nextRun: number | null; paused: boolean } | null> {
    const keys = buildScheduleKeys(this.prefix);
    const [config, score] = await this.client
      .pipeline()
      .hget(keys.schedules, name)
      .zscore(keys.schedulesNext, name)
      .exec()
      .then((results) => [
        (results as [Error | null, unknown][])[0][1] as string | null,
        (results as [Error | null, unknown][])[1][1] as string | null,
      ]);

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
      this.client.hgetall(keys.schedules),
      this.client.zrange(keys.schedulesNext, 0, -1, "WITHSCORES"),
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
    await this.client
      .pipeline()
      .hset(keys.schedules, name, config)
      .zadd(keys.schedulesNext, String(nextRun), name)
      .exec();
  }

  async pauseSchedule(name: string): Promise<void> {
    const keys = buildScheduleKeys(this.prefix);
    await this.client.zrem(keys.schedulesNext, name);
  }

  async resumeSchedule(name: string, nextRun: number): Promise<void> {
    const keys = buildScheduleKeys(this.prefix);
    await this.client.zadd(keys.schedulesNext, String(nextRun), name);
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
    const sub = this.client.duplicate();
    await sub.connect();
    await sub.subscribe(keys.cancelChannel);
    sub.on("message", (_channel: string, message: string) => {
      handler(message);
    });
    return () => {
      sub.unsubscribe();
      sub.disconnect(false);
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

  // ── Workflows (Lua scripts TBD — using inline Redis commands for now) ──

  private wfKey(workflowId: string): string {
    const base = this.prefix ? `taskora:${this.prefix}` : "taskora";
    return `${base}:wf:{${workflowId}}`;
  }

  async createWorkflow(workflowId: string, graph: string): Promise<void> {
    const key = this.wfKey(workflowId);
    const parsed = JSON.parse(graph);
    const fields: string[] = [
      "graph", graph,
      "state", "running",
      "createdAt", String(Date.now()),
    ];
    for (let i = 0; i < parsed.nodes.length; i++) {
      fields.push(`n:${i}:state`, "pending");
    }
    await this.client.hmset(key, ...fields);
  }

  async advanceWorkflow(
    workflowId: string,
    nodeIndex: number,
    result: string,
  ): Promise<Taskora.WorkflowAdvanceResult> {
    const key = this.wfKey(workflowId);
    const state = await this.client.hget(key, "state");
    if (state !== "running") return { toDispatch: [], completed: false };

    // Mark node completed
    await this.client.hmset(key,
      `n:${nodeIndex}:state`, "completed",
      `n:${nodeIndex}:result`, result,
    );

    const graphStr = await this.client.hget(key, "graph");
    if (!graphStr) return { toDispatch: [], completed: false };
    const graph = JSON.parse(graphStr);

    const toDispatch: Taskora.WorkflowAdvanceResult["toDispatch"] = [];

    for (let i = 0; i < graph.nodes.length; i++) {
      const nodeState = await this.client.hget(key, `n:${i}:state`);
      if (nodeState !== "pending") continue;
      const node = graph.nodes[i];
      if (!node.deps.includes(nodeIndex)) continue;

      let allDepsCompleted = true;
      for (const d of node.deps) {
        const ds = await this.client.hget(key, `n:${d}:state`);
        if (ds !== "completed") { allDepsCompleted = false; break; }
      }
      if (!allDepsCompleted) continue;

      let inputData: string;
      if (node.data !== undefined) {
        inputData = node.data;
      } else if (node.deps.length === 1) {
        inputData = (await this.client.hget(key, `n:${node.deps[0]}:result`))!;
      } else {
        const results: string[] = [];
        for (const d of node.deps) {
          results.push((await this.client.hget(key, `n:${d}:result`))!);
        }
        inputData = `[${results.join(",")}]`;
      }

      await this.client.hset(key, `n:${i}:state`, "active");
      toDispatch.push({ nodeIndex: i, taskName: node.taskName, data: inputData, jobId: node.jobId, _v: node._v });
    }

    const allTerminalDone = (graph.terminal as number[]).every((i: number) => {
      // We just set nodeIndex to completed, check inline
      return true; // will verify below
    });

    // Re-check terminals properly
    let completed = true;
    for (const ti of graph.terminal as number[]) {
      const ts = ti === nodeIndex ? "completed" : await this.client.hget(key, `n:${ti}:state`);
      if (ts !== "completed") { completed = false; break; }
    }

    if (completed) {
      const terminalNodes = graph.terminal as number[];
      let finalResult: string | undefined;
      if (terminalNodes.length === 1) {
        finalResult = terminalNodes[0] === nodeIndex ? result : (await this.client.hget(key, `n:${terminalNodes[0]}:result`)) ?? undefined;
      } else {
        const results: string[] = [];
        for (const ti of terminalNodes) {
          results.push(ti === nodeIndex ? result : (await this.client.hget(key, `n:${ti}:result`))!);
        }
        finalResult = `[${results.join(",")}]`;
      }
      await this.client.hmset(key, "state", "completed", "result", finalResult ?? "");
      return { toDispatch, completed: true, result: finalResult };
    }

    return { toDispatch, completed: false };
  }

  async failWorkflow(
    workflowId: string,
    nodeIndex: number,
    error: string,
  ): Promise<Taskora.WorkflowFailResult> {
    const key = this.wfKey(workflowId);
    const state = await this.client.hget(key, "state");
    if (state !== "running") return { activeJobIds: [] };

    await this.client.hmset(key,
      `n:${nodeIndex}:state`, "failed",
      `n:${nodeIndex}:error`, error,
      "state", "failed",
      "error", error,
    );

    const graphStr = await this.client.hget(key, "graph");
    if (!graphStr) return { activeJobIds: [] };
    const graph = JSON.parse(graphStr);

    const activeJobIds: Array<{ task: string; jobId: string }> = [];
    for (let i = 0; i < graph.nodes.length; i++) {
      if (i === nodeIndex) continue;
      const ns = await this.client.hget(key, `n:${i}:state`);
      if (ns === "active") {
        activeJobIds.push({ task: graph.nodes[i].taskName, jobId: graph.nodes[i].jobId });
        await this.client.hset(key, `n:${i}:state`, "failed");
      } else if (ns === "pending") {
        await this.client.hset(key, `n:${i}:state`, "failed");
      }
    }

    return { activeJobIds };
  }

  async getWorkflowState(workflowId: string): Promise<string | null> {
    const key = this.wfKey(workflowId);
    const [state, result, error] = await this.client.hmget(key, "state", "result", "error");
    if (!state) return null;
    return JSON.stringify({ state, result: result ?? undefined, error: error ?? undefined });
  }

  async cancelWorkflow(
    workflowId: string,
    reason?: string,
  ): Promise<Taskora.WorkflowCancelResult> {
    const key = this.wfKey(workflowId);
    const state = await this.client.hget(key, "state");
    if (state !== "running") return { activeJobIds: [] };

    await this.client.hmset(key, "state", "cancelled", "error", reason ?? "");

    const graphStr = await this.client.hget(key, "graph");
    if (!graphStr) return { activeJobIds: [] };
    const graph = JSON.parse(graphStr);

    const activeJobIds: Array<{ task: string; jobId: string }> = [];
    for (let i = 0; i < graph.nodes.length; i++) {
      const ns = await this.client.hget(key, `n:${i}:state`);
      if (ns === "active") {
        activeJobIds.push({ task: graph.nodes[i].taskName, jobId: graph.nodes[i].jobId });
        await this.client.hset(key, `n:${i}:state`, "cancelled");
      } else if (ns === "pending") {
        await this.client.hset(key, `n:${i}:state`, "cancelled");
      }
    }

    return { activeJobIds };
  }

  async getWorkflowMeta(
    task: string,
    jobId: string,
  ): Promise<{ workflowId: string; nodeIndex: number } | null> {
    const keys = buildKeys(task, this.prefix);
    const jobKey = keys.jobPrefix + jobId;
    const [wf, wfNode] = await this.client.hmget(jobKey, "_wf", "_wfNode");
    if (!wf) return null;
    return { workflowId: wf, nodeIndex: Number(wfNode ?? 0) };
  }

  private async loadScripts(): Promise<void> {
    for (const [name, source] of Object.entries(SCRIPT_MAP)) {
      const sha = (await this.client.script("LOAD", source)) as string;
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

    try {
      return await this.client.evalsha(sha, numkeys, ...args);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("NOSCRIPT")) {
        const source = SCRIPT_MAP[scriptName];
        const result = await this.client.eval(source, numkeys, ...args);
        const newSha = (await this.client.script("LOAD", source)) as string;
        this.shas.set(scriptName, newSha);
        return result;
      }
      throw err;
    }
  }
}
