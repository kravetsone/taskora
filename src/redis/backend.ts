import { Redis } from "ioredis";
import type { RedisOptions } from "ioredis";
import type { Taskora } from "../types.js";
import { buildKeys } from "./keys.js";
import * as scripts from "./scripts.js";

const SCRIPT_MAP: Record<string, string> = {
  enqueue: scripts.ENQUEUE,
  enqueueDelayed: scripts.ENQUEUE_DELAYED,
  dequeue: scripts.DEQUEUE,
  ack: scripts.ACK,
  fail: scripts.FAIL,
  nack: scripts.NACK,
  extendLock: scripts.EXTEND_LOCK,
};

export class RedisBackend implements Taskora.Adapter {
  private client: Redis;
  private ownsClient: boolean;
  private prefix?: string;
  private shas = new Map<string, string>();

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
    if (this.ownsClient) {
      await this.client.quit();
    }
  }

  async enqueue(
    task: string,
    jobId: string,
    data: string,
    options: { _v: number; maxAttempts?: number } & Taskora.JobOptions,
  ): Promise<void> {
    const keys = buildKeys(task, this.prefix);
    const now = String(Date.now());
    const maxAttempts = String(options.maxAttempts ?? 1);

    if (options.delay && options.delay > 0) {
      await this.eval(
        "enqueueDelayed",
        2,
        keys.delayed,
        keys.events,
        keys.jobPrefix,
        jobId,
        data,
        now,
        String(options._v),
        String(options.delay),
        String(options.priority ?? 0),
        maxAttempts,
      );
      return;
    }

    await this.eval(
      "enqueue",
      2,
      keys.wait,
      keys.events,
      keys.jobPrefix,
      jobId,
      data,
      now,
      String(options._v),
      String(options.priority ?? 0),
      maxAttempts,
    );
  }

  async dequeue(
    task: string,
    lockTtl: number,
    token: string,
  ): Promise<Taskora.DequeueResult | null> {
    const keys = buildKeys(task, this.prefix);

    const result = await this.eval(
      "dequeue",
      4,
      keys.wait,
      keys.active,
      keys.delayed,
      keys.events,
      keys.jobPrefix,
      String(lockTtl),
      token,
      String(Date.now()),
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

  async ack(task: string, jobId: string, token: string, result: string): Promise<void> {
    const keys = buildKeys(task, this.prefix);
    await this.eval(
      "ack",
      3,
      keys.active,
      keys.completed,
      keys.events,
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
      4,
      keys.active,
      keys.failed,
      keys.events,
      keys.delayed,
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
    await this.eval("nack", 3, keys.active, keys.wait, keys.events, keys.jobPrefix, jobId, token);
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

  async extendLock(task: string, jobId: string, token: string, ttl: number): Promise<boolean> {
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
    return result === 1;
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
