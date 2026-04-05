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

// ── Inspector: stats ────────────────────────────────────────────────

describe("inspector.stats()", () => {
  it("returns correct counts across states", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });
    const processed: string[] = [];

    const task = app.task<string, string>("counter", async (data) => {
      processed.push(data);
      return data;
    });

    task.dispatch("a");
    task.dispatch("b");
    task.dispatch("c");

    // Wait for enqueue
    await new Promise((r) => setTimeout(r, 100));

    const beforeStats = await app.inspect().stats();
    expect(beforeStats.waiting).toBe(3);
    expect(beforeStats.active).toBe(0);

    await app.start();
    await waitFor(() => processed.length === 3);

    const afterStats = await app.inspect().stats();
    expect(afterStats.waiting).toBe(0);
    expect(afterStats.completed).toBe(3);

    await app.close();
  });

  it("stats({ task }) filters to a single task", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    const taskA = app.task<string, string>("task-a", async (d) => d);
    const taskB = app.task<string, string>("task-b", async (d) => d);

    taskA.dispatch("1");
    taskA.dispatch("2");
    taskB.dispatch("3");

    await new Promise((r) => setTimeout(r, 100));

    const statsA = await app.inspect().stats({ task: "task-a" });
    expect(statsA.waiting).toBe(2);

    const statsB = await app.inspect().stats({ task: "task-b" });
    expect(statsB.waiting).toBe(1);

    await app.start();
    await waitFor(async () => {
      const s = await app.inspect().stats();
      return s.completed === 3;
    });
    await app.close();
  });
});

// ── Inspector: list queries ─────────────────────────────────────────

describe("inspector list queries", () => {
  it("waiting() returns enqueued jobs", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    app.task<{ n: number }, void>("list-test", async () => {
      // never processes — we don't start()
    });

    const t = app.task<{ n: number }, void>("list-test-2", async () => {});
    t.dispatch({ n: 1 });
    t.dispatch({ n: 2 });

    await new Promise((r) => setTimeout(r, 100));

    const waiting = await app.inspect().waiting({ task: "list-test-2" });
    expect(waiting).toHaveLength(2);
    expect(waiting[0].task).toBe("list-test-2");
    expect(waiting[0].state).toBe("waiting");
    expect(waiting[0].data).toEqual({ n: 1 });
    expect(waiting[1].data).toEqual({ n: 2 });

    await app.close();
  });

  it("completed() returns finished jobs with results", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });
    const processed: string[] = [];

    const t = app.task<string, { echo: string }>("echo", async (d) => {
      processed.push(d);
      return { echo: d };
    });

    t.dispatch("hello");
    t.dispatch("world");

    await app.start();
    await waitFor(() => processed.length === 2);

    const jobs = await app.inspect().completed({ task: "echo" });
    expect(jobs).toHaveLength(2);
    // completed returns newest first (ZREVRANGE)
    for (const job of jobs) {
      expect(job.state).toBe("completed");
      expect(job.result).toBeDefined();
      expect(job.finishedOn).toBeGreaterThan(0);
    }

    await app.close();
  });

  it("failed() returns permanently failed jobs", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });
    const failCount: number[] = [];

    app.task("fail-me", async () => {
      failCount.push(1);
      throw new Error("permanent failure");
    });

    const t = app.task<null, void>("fail-me-2", async () => {
      throw new Error("permanent failure");
    });
    t.dispatch(null);

    await app.start();
    await waitFor(async () => {
      const s = await app.inspect().stats({ task: "fail-me-2" });
      return s.failed === 1;
    });

    const failed = await app.inspect().failed({ task: "fail-me-2" });
    expect(failed).toHaveLength(1);
    expect(failed[0].state).toBe("failed");
    expect(failed[0].error).toBe("permanent failure");

    await app.close();
  });

  it("delayed() returns delayed jobs", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    const t = app.task<string, string>("delayed-task", async (d) => d);
    t.dispatch("later", { delay: 60_000 });

    await new Promise((r) => setTimeout(r, 100));

    const delayed = await app.inspect().delayed({ task: "delayed-task" });
    expect(delayed).toHaveLength(1);
    expect(delayed[0].state).toBe("delayed");
    expect(delayed[0].data).toBe("later");

    await app.close();
  });

  it("list queries respect limit and offset", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    const t = app.task<number, void>("limit-test", async () => {});

    for (let i = 0; i < 5; i++) {
      t.dispatch(i);
    }
    await new Promise((r) => setTimeout(r, 200));

    const page1 = await app.inspect().waiting({ task: "limit-test", limit: 2, offset: 0 });
    expect(page1).toHaveLength(2);

    const page2 = await app.inspect().waiting({ task: "limit-test", limit: 2, offset: 2 });
    expect(page2).toHaveLength(2);

    const page3 = await app.inspect().waiting({ task: "limit-test", limit: 2, offset: 4 });
    expect(page3).toHaveLength(1);

    await app.close();
  });
});

// ── Inspector: find ─────────────────────────────────────────────────

describe("inspector.find()", () => {
  it("find(jobId) returns full job details with timeline", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    const t = app.task<{ msg: string }, { ok: boolean }>("find-test", async (data, ctx) => {
      ctx.log.info("processing", { key: "value" });
      return { ok: true };
    });

    const handle = t.dispatch({ msg: "hello" });
    const jobId = await handle;

    await app.start();
    await waitFor(async () => {
      const s = await app.inspect().stats({ task: "find-test" });
      return s.completed === 1;
    });

    const job = await app.inspect().find(jobId);
    expect(job).not.toBeNull();
    expect(job!.id).toBe(jobId);
    expect(job!.task).toBe("find-test");
    expect(job!.state).toBe("completed");
    expect(job!.data).toEqual({ msg: "hello" });
    expect(job!.result).toEqual({ ok: true });
    expect(job!.attempt).toBe(1);

    // Timeline
    expect(job!.timeline.length).toBeGreaterThanOrEqual(2);
    expect(job!.timeline[0].state).toBe("waiting");
    expect(job!.timeline[0].at).toBeGreaterThan(0);
    const activeEntry = job!.timeline.find((e) => e.state === "active");
    expect(activeEntry).toBeDefined();

    // Logs
    expect(job!.logs).toHaveLength(1);
    expect(job!.logs[0].level).toBe("info");
    expect(job!.logs[0].message).toBe("processing");

    await app.close();
  });

  it("find(task, jobId) returns typed result", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    const t = app.task<{ x: number }, { doubled: number }>("typed-find", async (data) => {
      return { doubled: data.x * 2 };
    });

    const handle = t.dispatch({ x: 5 });
    const jobId = await handle;

    await app.start();
    await waitFor(async () => {
      const s = await app.inspect().stats({ task: "typed-find" });
      return s.completed === 1;
    });

    const job = await app.inspect().find(t, jobId);
    expect(job).not.toBeNull();
    expect(job!.data).toEqual({ x: 5 });
    expect(job!.result).toEqual({ doubled: 10 });

    await app.close();
  });

  it("find() returns null for non-existent job", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });
    app.task("noop", async () => {});

    const job = await app.inspect().find("non-existent-id");
    expect(job).toBeNull();

    await app.close();
  });
});

// ── Dead Letter Queue ───────────────────────────────────────────────

describe("dead letter queue", () => {
  it("permanently failed job appears in deadLetters.list()", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });

    const t = app.task<null, void>("dlq-fail", async () => {
      throw new Error("kaboom");
    });
    t.dispatch(null);

    await app.start();
    await waitFor(async () => {
      const s = await app.inspect().stats({ task: "dlq-fail" });
      return s.failed === 1;
    });

    const dead = await app.deadLetters.list({ task: "dlq-fail" });
    expect(dead).toHaveLength(1);
    expect(dead[0].state).toBe("failed");
    expect(dead[0].error).toBe("kaboom");

    await app.close();
  });

  it("deadLetters.retry(jobId) re-enqueues a failed job", async () => {
    let attempt = 0;
    const app = taskora({ adapter: redisAdapter(url()) });

    const t = app.task<null, string>("dlq-retry", async () => {
      attempt++;
      if (attempt === 1) throw new Error("first try fails");
      return "success";
    });
    t.dispatch(null);

    await app.start();
    await waitFor(async () => {
      const s = await app.inspect().stats({ task: "dlq-retry" });
      return s.failed === 1;
    });

    // Retry from DLQ
    const retried = await app.deadLetters.retry(
      "dlq-retry",
      (await app.deadLetters.list({ task: "dlq-retry" }))[0].id,
    );
    expect(retried).toBe(true);

    // Should be re-processed and succeed
    await waitFor(async () => {
      const s = await app.inspect().stats({ task: "dlq-retry" });
      return s.completed === 1;
    });

    expect(attempt).toBe(2);
    await app.close();
  });

  it("deadLetters.retry(jobId) cross-task search", async () => {
    let attempt = 0;
    const app = taskora({ adapter: redisAdapter(url()) });

    const t = app.task<null, string>("dlq-cross", async () => {
      attempt++;
      if (attempt === 1) throw new Error("fail");
      return "ok";
    });
    const handle = t.dispatch(null);
    const jobId = await handle;

    await app.start();
    await waitFor(async () => {
      const s = await app.inspect().stats({ task: "dlq-cross" });
      return s.failed === 1;
    });

    // Retry using only jobId (no task name)
    const retried = await app.deadLetters.retry(jobId);
    expect(retried).toBe(true);

    await waitFor(async () => {
      const s = await app.inspect().stats({ task: "dlq-cross" });
      return s.completed === 1;
    });

    await app.close();
  });

  it("deadLetters.retryAll() re-enqueues all failed jobs", async () => {
    let failCount = 0;
    let successCount = 0;
    const app = taskora({ adapter: redisAdapter(url()) });

    const t = app.task<number, void>("dlq-retry-all", async (n) => {
      if (failCount < 3) {
        failCount++;
        throw new Error(`fail-${n}`);
      }
      successCount++;
    });

    t.dispatch(1);
    t.dispatch(2);
    t.dispatch(3);

    await app.start();
    await waitFor(async () => {
      const s = await app.inspect().stats({ task: "dlq-retry-all" });
      return s.failed === 3;
    });

    const count = await app.deadLetters.retryAll({ task: "dlq-retry-all" });
    expect(count).toBe(3);

    await waitFor(async () => {
      const s = await app.inspect().stats({ task: "dlq-retry-all" });
      return s.completed === 3;
    });

    expect(successCount).toBe(3);
    await app.close();
  });

  it("deadLetters.retry() returns false for non-existent job", async () => {
    const app = taskora({ adapter: redisAdapter(url()) });
    app.task("dlq-noop", async () => {});

    const retried = await app.deadLetters.retry("non-existent");
    expect(retried).toBe(false);

    await app.close();
  });
});

// ── DLQ maxAge trim ─────────────────────────────────────────────────

describe("DLQ maxAge retention", () => {
  it("trimDLQ removes jobs older than maxAge", async () => {
    const adapter = redisAdapter(url());
    const app = taskora({ adapter });

    const t = app.task<null, void>("dlq-trim", async () => {
      throw new Error("fail");
    });
    t.dispatch(null);

    await app.start();
    await waitFor(async () => {
      const s = await app.inspect().stats({ task: "dlq-trim" });
      return s.failed === 1;
    });

    // Manually set the finishedOn score to an old timestamp
    const failedJobs = await redis.zrange("taskora:{dlq-trim}:failed", 0, -1);
    expect(failedJobs).toHaveLength(1);
    await redis.zadd("taskora:{dlq-trim}:failed", String(Date.now() - 100_000), failedJobs[0]);

    // Trim with a cutoff of 50s ago — should remove the old job
    const trimmed = await adapter.trimDLQ("dlq-trim", Date.now() - 50_000, 0);
    expect(trimmed).toBe(1);

    // Verify it's gone
    const remaining = await redis.zcard("taskora:{dlq-trim}:failed");
    expect(remaining).toBe(0);

    // Verify job keys are cleaned up
    const jobHash = await redis.hgetall(`taskora:{dlq-trim}:${failedJobs[0]}`);
    expect(Object.keys(jobHash)).toHaveLength(0);

    await app.close();
  });
});
