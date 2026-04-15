import Redis from "ioredis";
import { readUsedMemory } from "../redis.js";
import type { BenchAdapter, CompletionHandle, LatencyHandle } from "../types.js";

export class TaskoraAdapter implements BenchAdapter {
  readonly name = "taskora";

  private redisUrl = "";
  private redis: Redis | null = null;
  private currentApp: import("taskora").App | null = null;

  async setup(redisUrl: string): Promise<void> {
    this.redisUrl = redisUrl;
    this.redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: null });
    await this.redis.connect();
    await this.redis.ping();
  }

  private async createApp(extra?: Record<string, unknown>) {
    const { createTaskora } = await import("taskora");
    const { redisAdapter } = await import("taskora/redis");
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
    if (this.redis) {
      await this.redis.flushdb();
    }
  }

  async getMemoryUsage(): Promise<number> {
    if (!this.redis) throw new Error("TaskoraAdapter not set up");
    return readUsedMemory(this.redis);
  }

  async teardown(): Promise<void> {
    if (this.currentApp) {
      await this.currentApp.close();
      this.currentApp = null;
    }
    if (this.redis) {
      this.redis.disconnect();
      this.redis = null;
    }
  }
}
