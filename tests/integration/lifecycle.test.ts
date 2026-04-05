import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { taskora } from "../../src/index.js";
import { redisAdapter } from "../../src/redis/index.js";
import { url, waitFor } from "../helpers.js";

let redis: Redis;

beforeEach(() => {
  redis = new Redis(url());
});

afterEach(async () => {
  await redis.flushdb();
  await redis.quit();
});

// ── Happy path ─────────────────────────────────────────────────────

describe("job lifecycle", () => {
  it("dispatch → process → complete", async () => {
    const processed: Array<{ to: string }> = [];

    const app = taskora({ adapter: redisAdapter(url()) });

    const sendEmail = app.task("send-email", async (data: { to: string }) => {
      processed.push(data);
      return { ok: true };
    });

    const handle = sendEmail.dispatch({ to: "alice@example.com" });
    const jobId = await handle;
    expect(typeof jobId).toBe("string");
    expect(jobId.length).toBe(36);

    await app.start();

    await waitFor(() => processed.length === 1);
    expect(processed[0]).toEqual({ to: "alice@example.com" });

    // Verify job is in completed set
    const completedCount = await redis.zcard("taskora:{send-email}:completed");
    expect(completedCount).toBe(1);

    // Verify result is stored
    const result = await redis.get(`taskora:{send-email}:${jobId}:result`);
    expect(result).toBeDefined();
    expect(JSON.parse(result as string)).toEqual({ ok: true });

    await app.close();
  });

  it("dispatch → process → fail (error in handler)", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    app.task("failing-task", async () => {
      throw new Error("boom");
    });

    const task = app.task("failing-task-dispatch", async () => {
      throw new Error("boom");
    });

    const handle = task.dispatch({});
    const jobId = await handle;
    await app.start();

    await waitFor(async () => {
      const failedCount = await redis.zcard("taskora:{failing-task-dispatch}:failed");
      return failedCount === 1;
    });

    // Verify error stored in metadata
    const error = await redis.hget(`taskora:{failing-task-dispatch}:${jobId}`, "error");
    expect(error).toBe("boom");

    await app.close();
  });

  it("processes multiple jobs sequentially (concurrency=1)", async () => {
    const order: number[] = [];

    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("sequential", async (data: { n: number }) => {
      order.push(data.n);
      return null;
    });

    // Enqueue sequentially to guarantee FIFO ordering
    await task.dispatch({ n: 1 });
    await task.dispatch({ n: 2 });
    await task.dispatch({ n: 3 });

    await app.start();
    await waitFor(() => order.length === 3);

    expect(order).toEqual([1, 2, 3]);
    await app.close();
  });
});

// ── Delayed jobs ───────────────────────────────────────────────────

describe("delayed jobs", () => {
  it("promotes and processes after delay", async () => {
    const processed: string[] = [];

    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("delayed-task", async (data: { msg: string }) => {
      processed.push(data.msg);
      return null;
    });

    const handle = task.dispatch({ msg: "hello" }, { delay: 500 });
    await handle;

    // Should be in delayed set, not wait list
    const delayedCount = await redis.zcard("taskora:{delayed-task}:delayed");
    expect(delayedCount).toBe(1);
    const waitCount = await redis.llen("taskora:{delayed-task}:wait");
    expect(waitCount).toBe(0);

    await app.start();

    // Should NOT be processed immediately
    await new Promise((r) => setTimeout(r, 100));
    expect(processed.length).toBe(0);

    // Should be processed after delay
    await waitFor(() => processed.length === 1, 5_000);
    expect(processed[0]).toBe("hello");

    await app.close();
  });
});

// ── Concurrency ────────────────────────────────────────────────────

describe("concurrency", () => {
  it("concurrent workers don't double-process", async () => {
    const processedIds = new Set<string>();
    let duplicates = 0;

    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("concurrent", {
      concurrency: 5,
      handler: async (data: { id: string }, ctx) => {
        if (processedIds.has(data.id)) duplicates++;
        processedIds.add(data.id);
        // Simulate some work
        await new Promise((r) => setTimeout(r, 50));
        return null;
      },
    });

    // Dispatch 20 jobs
    const handles = [];
    for (let i = 0; i < 20; i++) {
      handles.push(task.dispatch({ id: String(i) }));
    }
    await Promise.all(handles);

    await app.start();
    await waitFor(() => processedIds.size === 20);

    expect(duplicates).toBe(0);
    expect(processedIds.size).toBe(20);

    await app.close();
  });
});

// ── Graceful shutdown ──────────────────────────────────────────────

describe("graceful shutdown", () => {
  it("waits for active jobs to finish", async () => {
    let jobStarted = false;
    let jobFinished = false;

    const app = taskora({ adapter: redisAdapter(url()) });

    app.task("slow-task", async () => {
      jobStarted = true;
      await new Promise((r) => setTimeout(r, 500));
      jobFinished = true;
      return null;
    });

    const task = app.task("slow-dispatch", async () => {
      jobStarted = true;
      await new Promise((r) => setTimeout(r, 500));
      jobFinished = true;
      return null;
    });

    const handle = task.dispatch({});
    await handle;
    await app.start();

    await waitFor(() => jobStarted);

    // Close without timeout — should wait for the job to finish
    await app.close();

    expect(jobFinished).toBe(true);
  });
});

// ── Bulk dispatch ──────────────────────────────────────────────────

describe("bulk dispatch", () => {
  it("dispatchMany enqueues all jobs", async () => {
    const processed: string[] = [];

    const app = taskora({ adapter: redisAdapter(url()) });

    const task = app.task("bulk", async (data: { name: string }) => {
      processed.push(data.name);
      return null;
    });

    const handles = task.dispatchMany([
      { data: { name: "a" } },
      { data: { name: "b" } },
      { data: { name: "c" } },
    ]);

    expect(handles).toHaveLength(3);
    const ids = await Promise.all(handles);
    for (const id of ids) expect(typeof id).toBe("string");

    await app.start();
    await waitFor(() => processed.length === 3);

    expect(processed.sort()).toEqual(["a", "b", "c"]);
    await app.close();
  });
});

// ── Connection modes ───────────────────────────────────────────────

describe("connection modes", () => {
  it("accepts a connection URL string", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });
    const task = app.task("url-test", async () => null);
    const handle = task.dispatch({});
    await handle;
    await app.close();
  });

  it("accepts a RedisOptions object", async () => {
    // Parse URL to get host/port
    const u = new URL(url());
    const app = taskora({
      adapter: redisAdapter({
        host: u.hostname,
        port: Number(u.port),
      }),
    });
    const task = app.task("opts-test", async () => null);
    const handle = task.dispatch({});
    await handle;
    await app.close();
  });

  it("accepts an existing ioredis instance", async () => {
    const client = new Redis(url());
    const app = taskora({ adapter: redisAdapter(client) });
    const task = app.task("instance-test", async () => null);
    const handle = task.dispatch({});
    await handle;
    await app.close();
    // Client should still be usable (we don't own it)
    expect(await client.ping()).toBe("PONG");
    await client.quit();
  });
});
