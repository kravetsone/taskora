import type { Redis } from "ioredis";
import type { Taskora } from "../types.js";
import { buildKeys } from "./keys.js";

interface Pending {
  task: string;
  jobId: string;
  resolve: (result: Taskora.AwaitJobResult | null) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const STATE_CHECK_INTERVAL = 2_000;

export class JobWaiter {
  private readonly mainClient: Redis;
  private readonly prefix?: string;

  private subClient: Redis | null = null;
  private pending = new Map<string, Pending>();
  private streams = new Map<string, string>();
  private taskByStream = new Map<string, string>();
  private running = false;

  constructor(mainClient: Redis, prefix?: string) {
    this.mainClient = mainClient;
    this.prefix = prefix;
  }

  async wait(
    task: string,
    jobId: string,
    timeoutMs?: number,
  ): Promise<Taskora.AwaitJobResult | null> {
    const keys = buildKeys(task, this.prefix);

    // Snapshot stream position BEFORE state check to avoid race:
    // if job completes after snapshot, XREAD catches it;
    // if job completed before snapshot, state check sees it.
    if (!this.streams.has(keys.events)) {
      const last = (await this.mainClient.xrevrange(keys.events, "+", "-", "COUNT", "1")) as Array<
        [string, string[]]
      > | null;
      this.streams.set(keys.events, last && last.length > 0 ? last[0][0] : "0-0");
      this.taskByStream.set(keys.events, task);
    }

    // Fast path: check if already done
    const fast = await this.checkJobState(task, jobId);
    if (fast) return fast;

    const key = `${task}:${jobId}`;

    return new Promise<Taskora.AwaitJobResult | null>((resolve) => {
      const pending: Pending = { task, jobId, resolve };

      if (timeoutMs != null) {
        pending.timer = setTimeout(() => {
          this.pending.delete(key);
          resolve(null);
          this.cleanupIfEmpty();
        }, timeoutMs);
      }

      this.pending.set(key, pending);
      this.ensureRunning();
    });
  }

  async shutdown(): Promise<void> {
    this.running = false;
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.pending.clear();
    if (this.subClient) {
      this.subClient.disconnect(false);
      this.subClient = null;
    }
    this.streams.clear();
    this.taskByStream.clear();
  }

  private async ensureRunning(): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (!this.subClient) {
      this.subClient = this.mainClient.duplicate();
      await this.subClient.connect();
    }

    this.poll();
  }

  private async poll(): Promise<void> {
    let lastStateCheck = Date.now();

    while (this.running && this.pending.size > 0) {
      try {
        // Periodic state check as safety net for missed events
        if (Date.now() - lastStateCheck >= STATE_CHECK_INTERVAL) {
          await this.checkAllPendingStates();
          lastStateCheck = Date.now();
          if (this.pending.size === 0) break;
        }

        const streamKeys = [...this.streams.keys()];
        if (streamKeys.length === 0) {
          await sleep(100);
          continue;
        }

        const ids = streamKeys.map((s) => this.streams.get(s) ?? "0-0");

        const result = await this.subClient?.xread(
          "BLOCK",
          2000,
          "COUNT",
          100,
          "STREAMS",
          ...streamKeys,
          ...ids,
        );

        if (!result) continue;

        for (const [streamKey, entries] of result) {
          const task = this.taskByStream.get(streamKey);
          if (!task) continue;

          for (const [entryId, fieldArr] of entries) {
            this.streams.set(streamKey, entryId);

            const fields: Record<string, string> = {};
            for (let i = 0; i < fieldArr.length; i += 2) {
              fields[fieldArr[i]] = fieldArr[i + 1];
            }

            const jobId = fields.jobId;
            const event = fields.event;
            if (!jobId || !event) continue;

            if (event !== "completed" && event !== "failed" && event !== "cancelled") continue;

            const key = `${task}:${jobId}`;
            const pending = this.pending.get(key);
            if (!pending) continue;

            this.pending.delete(key);
            if (pending.timer) clearTimeout(pending.timer);

            const jobResult = await this.fetchJobResult(
              task,
              jobId,
              event as "completed" | "failed",
            );
            pending.resolve(jobResult);
          }
        }
      } catch {
        if (!this.running) break;
        await sleep(500);
      }
    }

    this.running = false;
    this.cleanupIfEmpty();
  }

  private async checkAllPendingStates(): Promise<void> {
    for (const [key, pending] of this.pending) {
      const result = await this.checkJobState(pending.task, pending.jobId);
      if (result) {
        this.pending.delete(key);
        if (pending.timer) clearTimeout(pending.timer);
        pending.resolve(result);
      }
    }
  }

  private async checkJobState(task: string, jobId: string): Promise<Taskora.AwaitJobResult | null> {
    const keys = buildKeys(task, this.prefix);
    const jobKey = `${keys.jobPrefix}${jobId}`;
    const state = await this.mainClient.hget(jobKey, "state");

    if (state === "completed" || state === "failed" || state === "cancelled") {
      return this.fetchJobResult(task, jobId, state as "completed" | "failed" | "cancelled");
    }
    return null;
  }

  private async fetchJobResult(
    task: string,
    jobId: string,
    state: "completed" | "failed" | "cancelled",
  ): Promise<Taskora.AwaitJobResult> {
    const keys = buildKeys(task, this.prefix);
    const jobKey = `${keys.jobPrefix}${jobId}`;

    if (state === "completed") {
      const result = await this.mainClient.get(`${jobKey}:result`);
      return { state, result: result ?? undefined };
    }
    if (state === "failed") {
      const error = await this.mainClient.hget(jobKey, "error");
      return { state, error: error ?? undefined };
    }
    return { state };
  }

  private cleanupIfEmpty(): void {
    if (this.pending.size > 0) return;
    if (this.subClient) {
      this.subClient.disconnect(false);
      this.subClient = null;
    }
    this.streams.clear();
    this.taskByStream.clear();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
