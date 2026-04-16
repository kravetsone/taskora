import { readUsedMemory } from "../redis.js";
import type { BenchAdapter, CompletionHandle, LatencyHandle } from "../types.js";

/**
 * Taskora bench adapter using the Bun native Redis driver (`taskora/redis/bun`).
 *
 * Only works under the Bun runtime — `Bun.RedisClient` is a built-in.
 * Falls back to ioredis with a clear error if not on Bun.
 */
export class TaskoraBunAdapter implements BenchAdapter {
  readonly name = "taskora-bun";

  private redisUrl = "";
  private infoClient: { info(section: string): Promise<string>; disconnect(): void } | null = null;
  private currentApp: import("taskora").App | null = null;

  async setup(redisUrl: string): Promise<void> {
    if (typeof globalThis.Bun === "undefined") {
      throw new Error("TaskoraBunAdapter requires the Bun runtime");
    }
    this.redisUrl = redisUrl;

    // Use ioredis for INFO commands — Bun.RedisClient can't parse INFO output easily
    const Redis = (await import("ioredis")).default;
    const client = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: null });
    await client.connect();
    this.infoClient = client;
  }

  private async createApp(extra?: Record<string, unknown>) {
    const { createTaskora } = await import("taskora");
    const { redisAdapter } = await import("taskora/redis/bun");
    const app = createTaskora({
      adapter: redisAdapter(this.redisUrl),
      ...extra,
    });
    this.currentApp = app;
    return app;
  }

  async enqueueSingle(queueName: string, count: number): Promise<void> {
    const app = await this.createApp();
    const task = app.task<{ i: number }, unknown>(queueName, async (data) => data);

    for (let i = 0; i < count; i++) {
      await task.dispatch({ i });
    }

    await app.close();
    this.currentApp = null;
  }

  async enqueueBulk(queueName: string, count: number, batchSize: number): Promise<void> {
    const app = await this.createApp();
    const task = app.task<{ i: number }, unknown>(queueName, async (data) => data);

    for (let offset = 0; offset < count; offset += batchSize) {
      const size = Math.min(batchSize, count - offset);
      const jobs = Array.from({ length: size }, (_, j) => ({
        data: { i: offset + j },
      }));
      const handles = task.dispatchMany(jobs);
      await Promise.all(handles);
    }

    await app.close();
    this.currentApp = null;
  }

  async startProcessing(
    queueName: string,
    concurrency: number,
    count: number,
  ): Promise<CompletionHandle> {
    const app = await this.createApp({
      retention: {
        completed: { maxAge: "1h", maxItems: count + 1000 },
        failed: { maxAge: "1h", maxItems: 1000 },
      },
    });

    let completed = 0;
    let resolve: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });

    const task = app.task<{ i: number }, unknown>(queueName, {
      concurrency,
      handler: async (data) => {
        completed++;
        if (completed >= count) resolve();
        return data;
      },
    });

    // Pre-enqueue all jobs
    const batchSize = 100;
    for (let offset = 0; offset < count; offset += batchSize) {
      const size = Math.min(batchSize, count - offset);
      const jobs = Array.from({ length: size }, (_, j) => ({
        data: { i: offset + j },
      }));
      const handles = task.dispatchMany(jobs);
      await Promise.all(handles);
    }

    await app.start();

    return { done };
  }

  async startLatencyRun(
    queueName: string,
    concurrency: number,
    count: number,
  ): Promise<LatencyHandle> {
    const app = await this.createApp({
      retention: {
        completed: { maxAge: "1h", maxItems: count + 1000 },
        failed: { maxAge: "1h", maxItems: 1000 },
      },
    });

    const latencies: number[] = [];
    let completed = 0;
    let resolve: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });

    const task = app.task<{ i: number; t: number }, unknown>(queueName, {
      concurrency,
      handler: async (data) => {
        latencies.push(performance.now() - data.t);
        completed++;
        if (completed >= count) resolve();
        return data;
      },
    });

    await app.start();

    return {
      done,
      dispatchOne: async (data) => {
        await task.dispatch(data);
      },
      getLatencies: () => latencies,
    };
  }

  async cleanup(): Promise<void> {
    if (this.currentApp) {
      await this.currentApp.close();
      this.currentApp = null;
    }
    if (this.infoClient) {
      const Redis = (await import("ioredis")).default;
      const client = new Redis(this.redisUrl, { lazyConnect: true, maxRetriesPerRequest: null });
      await client.connect();
      await client.flushdb();
      client.disconnect();
    }
  }

  async getMemoryUsage(): Promise<number> {
    if (!this.infoClient) throw new Error("TaskoraBunAdapter not set up");
    return readUsedMemory(this.infoClient);
  }

  async teardown(): Promise<void> {
    if (this.currentApp) {
      await this.currentApp.close();
      this.currentApp = null;
    }
    if (this.infoClient) {
      this.infoClient.disconnect();
      this.infoClient = null;
    }
  }
}
