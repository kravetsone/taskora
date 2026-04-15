import Redis from "ioredis";
import type { BenchAdapter, CompletionHandle, LatencyHandle } from "../types.js";
import { parseRedisUrl, readUsedMemory } from "../redis.js";

export class BullMQAdapter implements BenchAdapter {
  readonly name = "bullmq";

  private redisUrl = "";
  private connection: { host: string; port: number; maxRetriesPerRequest: null } = {
    host: "",
    port: 0,
    maxRetriesPerRequest: null,
  };
  private redis: Redis | null = null;
  private currentQueue: import("bullmq").Queue | null = null;
  private currentWorker: import("bullmq").Worker | null = null;

  async setup(redisUrl: string): Promise<void> {
    this.redisUrl = redisUrl;
    const { host, port } = parseRedisUrl(redisUrl);
    this.connection = { host, port, maxRetriesPerRequest: null };
    this.redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: null });
    await this.redis.connect();
    await this.redis.ping();
  }

  async enqueueSingle(queueName: string, count: number): Promise<void> {
    const { Queue } = await import("bullmq");

    const queue = new Queue(queueName, { connection: this.connection });
    this.currentQueue = queue;

    for (let i = 0; i < count; i++) {
      await queue.add("job", { i });
    }

    await queue.close();
    this.currentQueue = null;
  }

  async enqueueBulk(queueName: string, count: number, batchSize: number): Promise<void> {
    const { Queue } = await import("bullmq");

    const queue = new Queue(queueName, { connection: this.connection });
    this.currentQueue = queue;

    for (let offset = 0; offset < count; offset += batchSize) {
      const size = Math.min(batchSize, count - offset);
      const jobs = Array.from({ length: size }, (_, j) => ({
        name: "job",
        data: { i: offset + j },
      }));
      await queue.addBulk(jobs);
    }

    await queue.close();
    this.currentQueue = null;
  }

  async startProcessing(
    queueName: string,
    concurrency: number,
    count: number,
  ): Promise<CompletionHandle> {
    const { Queue, Worker } = await import("bullmq");

    const queue = new Queue(queueName, { connection: this.connection });
    this.currentQueue = queue;

    // Pre-enqueue all jobs
    const batchSize = 100;
    for (let offset = 0; offset < count; offset += batchSize) {
      const size = Math.min(batchSize, count - offset);
      const jobs = Array.from({ length: size }, (_, j) => ({
        name: "job",
        data: { i: offset + j },
        opts: { removeOnComplete: true, removeOnFail: true },
      }));
      await queue.addBulk(jobs);
    }

    let completed = 0;
    let resolve: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });

    const worker = new Worker(
      queueName,
      async () => {},
      {
        connection: this.connection,
        concurrency,
        removeOnComplete: { count: 0 },
        removeOnFail: { count: 0 },
      },
    );
    this.currentWorker = worker;

    worker.on("completed", () => {
      completed++;
      if (completed >= count) resolve();
    });

    await worker.waitUntilReady();

    return { done };
  }

  async startLatencyRun(
    queueName: string,
    concurrency: number,
    count: number,
  ): Promise<LatencyHandle> {
    const { Queue, Worker } = await import("bullmq");

    const queue = new Queue(queueName, { connection: this.connection });
    this.currentQueue = queue;

    const latencies: number[] = [];
    let completed = 0;
    let resolve: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });

    const worker = new Worker(
      queueName,
      async (job) => {
        latencies.push(performance.now() - (job.data as { t: number }).t);
        completed++;
        if (completed >= count) resolve();
      },
      {
        connection: this.connection,
        concurrency,
        removeOnComplete: { count: 0 },
        removeOnFail: { count: 0 },
      },
    );
    this.currentWorker = worker;

    await worker.waitUntilReady();

    return {
      done,
      dispatchOne: async (data) => {
        await queue.add("job", data);
      },
      getLatencies: () => latencies,
    };
  }

  async cleanup(): Promise<void> {
    if (this.currentWorker) {
      await this.currentWorker.close();
      this.currentWorker = null;
    }
    if (this.currentQueue) {
      try {
        await this.currentQueue.obliterate({ force: true });
      } catch {
        // Queue may already be cleaned
      }
      await this.currentQueue.close();
      this.currentQueue = null;
    }
    if (this.redis) {
      await this.redis.flushdb();
    }
  }

  async getMemoryUsage(): Promise<number> {
    if (!this.redis) throw new Error("BullMQAdapter not set up");
    return readUsedMemory(this.redis);
  }

  async teardown(): Promise<void> {
    if (this.currentWorker) {
      await this.currentWorker.close();
      this.currentWorker = null;
    }
    if (this.currentQueue) {
      await this.currentQueue.close();
      this.currentQueue = null;
    }
    if (this.redis) {
      this.redis.disconnect();
      this.redis = null;
    }
  }
}
