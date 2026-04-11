import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SchemaVersionMismatchError, createTaskora } from "../../src/index.js";
import {
  MIN_COMPAT_VERSION,
  WIRE_VERSION,
  writtenByForWireVersion,
} from "../../src/wire-version.js";
import { redisAdapter } from "../create-adapter.js";
import { url } from "../helpers.js";

let redis: Redis;

beforeEach(() => {
  redis = new Redis(url());
});

afterEach(async () => {
  await redis.flushdb();
  await redis.quit();
});

describe("wire-format handshake", () => {
  it("initializes the meta hash on first connect", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    await app.ensureConnected();

    const raw = await redis.hgetall("taskora:meta");
    expect(raw.wireVersion).toBe(String(WIRE_VERSION));
    expect(raw.minCompat).toBe(String(MIN_COMPAT_VERSION));
    expect(raw.writtenBy).toBe(writtenByForWireVersion(WIRE_VERSION));
    expect(Number(raw.writtenAt)).toBeGreaterThan(0);

    await app.close();
  });

  it("does not overwrite meta on a second compatible connect", async () => {
    const app1 = createTaskora({ adapter: redisAdapter(url()) });
    await app1.ensureConnected();
    const writtenAt = Number((await redis.hgetall("taskora:meta")).writtenAt);
    await app1.close();

    // A small delay so Date.now() would produce a fresh value if the meta
    // were being rewritten on second connect.
    await new Promise((r) => setTimeout(r, 5));

    const app2 = createTaskora({ adapter: redisAdapter(url()) });
    await app2.ensureConnected();
    const secondWrittenAt = Number((await redis.hgetall("taskora:meta")).writtenAt);
    expect(secondWrittenAt).toBe(writtenAt);

    await app2.close();
  });

  it("uses a separate meta key per prefix", async () => {
    const a = createTaskora({ adapter: redisAdapter(url(), { prefix: "tenant-a" }) });
    const b = createTaskora({ adapter: redisAdapter(url(), { prefix: "tenant-b" }) });
    await a.ensureConnected();
    await b.ensureConnected();

    expect(await redis.exists("taskora:tenant-a:meta")).toBe(1);
    expect(await redis.exists("taskora:tenant-b:meta")).toBe(1);
    expect(await redis.exists("taskora:meta")).toBe(0);

    await a.close();
    await b.close();
  });

  it("refuses to start when the backend was written by a newer incompatible taskora", async () => {
    // Simulate a v99 writer that promised minCompat=99 — no current build can
    // satisfy that window.
    await redis.hset("taskora:meta", {
      wireVersion: "99",
      minCompat: "99",
      writtenBy: "taskora@99.0.0",
      writtenAt: String(Date.now()),
    });

    const app = createTaskora({ adapter: redisAdapter(url()) });
    let caught: unknown;
    try {
      await app.ensureConnected();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaVersionMismatchError);
    const err = caught as SchemaVersionMismatchError;
    expect(err.code).toBe("theirs_too_new");
    expect(err.theirs.wireVersion).toBe(99);
    expect(err.theirs.writtenBy).toBe("taskora@99.0.0");
    expect(err.ours.wireVersion).toBe(WIRE_VERSION);
  });

  it("refuses to start on corrupt meta (minCompat > wireVersion)", async () => {
    // Use wireVersion=2 (= ours) so the auto-migrator doesn't fire —
    // we only want to exercise the invalid_meta detection path.
    await redis.hset("taskora:meta", {
      wireVersion: "2",
      minCompat: "5",
      writtenBy: "corrupt",
      writtenAt: "0",
    });

    const app = createTaskora({ adapter: redisAdapter(url()) });
    let caught: unknown;
    try {
      await app.ensureConnected();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaVersionMismatchError);
    expect((caught as SchemaVersionMismatchError).code).toBe("invalid_meta");
  });

  it("releases adapter resources after a failed handshake", async () => {
    // The contract is "fail fast and release resources" — after a mismatch,
    // the failed App instance is spent, but a fresh App against the same
    // Redis must still work once the mismatch is resolved. This verifies
    // the ensureConnected() cleanup path doesn't leak blocking clients or
    // leave the meta key dirty.
    await redis.hset("taskora:meta", {
      wireVersion: "99",
      minCompat: "99",
      writtenBy: "taskora@99.0.0",
      writtenAt: String(Date.now()),
    });

    const doomed = createTaskora({ adapter: redisAdapter(url()) });
    await expect(doomed.ensureConnected()).rejects.toBeInstanceOf(SchemaVersionMismatchError);

    // Clear the mismatch and bring up a fresh App — if the first one leaked
    // a connection or left Redis in a weird state, this will hang or fail.
    await redis.del("taskora:meta");
    const fresh = createTaskora({ adapter: redisAdapter(url()) });
    await fresh.ensureConnected();
    expect(await redis.exists("taskora:meta")).toBe(1);
    await fresh.close();
  });

  it("does not block normal task dispatch once the handshake succeeds", async () => {
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("handshake-smoke", async () => ({ ok: true }));
    const handle = task.dispatch({});
    const id = await handle;
    expect(typeof id).toBe("string");
    await app.close();
  });
});

// ── wireVersion 1 → 2 auto-migrator ─────────────────────────────────
//
// `RedisBackend.handshake()` detects a stored wireVersion=1 meta and runs
// `migrateWaitV1ToV2` before returning. The migrator converts every
// `:wait` key from LIST to ZSET in place, using a single Lua script per
// key so no concurrent writer can interleave. These tests seed a fake
// wireVersion=1 keyspace by hand and verify the auto-migration runs
// correctly under several shapes: empty waits, single-job waits,
// multi-job waits, multi-task keyspaces, and re-run idempotence.

describe("wire-format migration 1 → 2", () => {
  async function seedV1Meta() {
    // Write a fake wireVersion=1 meta record to trigger the migrator
    // on the next handshake.
    await redis.hset("taskora:meta", {
      wireVersion: "1",
      minCompat: "1",
      writtenBy: "taskora-wire-1",
      writtenAt: String(Date.now() - 1000),
    });
  }

  async function seedV1WaitJob(
    task: string,
    jobId: string,
    data: unknown,
    priority = 0,
  ): Promise<void> {
    const jobKey = `taskora:{${task}}:${jobId}`;
    const ts = Date.now();
    await redis.hset(jobKey, {
      ts: String(ts),
      _v: "1",
      attempt: "1",
      maxAttempts: "1",
      state: "waiting",
      priority: String(priority),
    });
    await redis.set(`${jobKey}:data`, JSON.stringify(data));
    // v1 wait-list semantics: LIST with LPUSH.
    await redis.lpush(`taskora:{${task}}:wait`, jobId);
  }

  it("single task with a handful of v1 jobs migrates to ZSET with correct scores", async () => {
    await seedV1Meta();
    await seedV1WaitJob("migr-small", "j1", { n: 1 }, 0);
    await new Promise((r) => setTimeout(r, 2));
    await seedV1WaitJob("migr-small", "j2", { n: 2 }, 10);
    await new Promise((r) => setTimeout(r, 2));
    await seedV1WaitJob("migr-small", "j3", { n: 3 }, 5);

    // Pre-migration: wait is a LIST.
    expect(await redis.type("taskora:{migr-small}:wait")).toBe("list");
    expect(await redis.llen("taskora:{migr-small}:wait")).toBe(3);

    const app = createTaskora({ adapter: redisAdapter(url()) });
    await app.ensureConnected();

    // Post-migration: wait is a ZSET with all three jobs, meta is v2.
    expect(await redis.type("taskora:{migr-small}:wait")).toBe("zset");
    expect(await redis.zcard("taskora:{migr-small}:wait")).toBe(3);
    const meta = await redis.hgetall("taskora:meta");
    expect(meta.wireVersion).toBe(String(WIRE_VERSION));

    // Dequeue via a worker — highest priority first.
    const processed: number[] = [];
    app.task("migr-small", {
      concurrency: 1,
      handler: async (data: { n: number }) => {
        processed.push(data.n);
      },
    });
    await app.start();
    // waitFor without helper import: use expect retries via a small loop.
    const deadline = Date.now() + 3000;
    while (processed.length < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // Priority 10 > 5 > 0 → [2, 3, 1].
    expect(processed).toEqual([2, 3, 1]);

    await app.close();
  });

  it("migrates multiple tasks in one handshake", async () => {
    await seedV1Meta();
    await seedV1WaitJob("migr-multi-a", "a1", { n: 1 });
    await seedV1WaitJob("migr-multi-a", "a2", { n: 2 });
    await seedV1WaitJob("migr-multi-b", "b1", { n: 10 });
    await seedV1WaitJob("migr-multi-c", "c1", { n: 100 });

    const app = createTaskora({ adapter: redisAdapter(url()) });
    await app.ensureConnected();

    // All three wait keys are now ZSETs with the right counts.
    expect(await redis.type("taskora:{migr-multi-a}:wait")).toBe("zset");
    expect(await redis.zcard("taskora:{migr-multi-a}:wait")).toBe(2);
    expect(await redis.type("taskora:{migr-multi-b}:wait")).toBe("zset");
    expect(await redis.zcard("taskora:{migr-multi-b}:wait")).toBe(1);
    expect(await redis.type("taskora:{migr-multi-c}:wait")).toBe("zset");
    expect(await redis.zcard("taskora:{migr-multi-c}:wait")).toBe(1);

    await app.close();
  });

  it("is idempotent — re-running the migrator on an already-v2 keyspace is a no-op", async () => {
    // First run: seeds v1, migrates on connect.
    await seedV1Meta();
    await seedV1WaitJob("migr-idem", "j1", { n: 1 });
    const app1 = createTaskora({ adapter: redisAdapter(url()) });
    await app1.ensureConnected();
    const waitAfterFirst = await redis.zrange("taskora:{migr-idem}:wait", 0, -1);
    await app1.close();

    // Second run: meta is v2, migrator should no-op. The wait contents
    // and scores must be byte-identical to the first run.
    const app2 = createTaskora({ adapter: redisAdapter(url()) });
    await app2.ensureConnected();
    const waitAfterSecond = await redis.zrange("taskora:{migr-idem}:wait", 0, -1);
    expect(waitAfterSecond).toEqual(waitAfterFirst);
    expect(await redis.type("taskora:{migr-idem}:wait")).toBe("zset");
    await app2.close();
  });

  it("handles an empty v1 keyspace cleanly (just bumps meta, nothing to migrate)", async () => {
    await seedV1Meta();
    const app = createTaskora({ adapter: redisAdapter(url()) });
    await app.ensureConnected();
    const meta = await redis.hgetall("taskora:meta");
    expect(meta.wireVersion).toBe(String(WIRE_VERSION));
    await app.close();
  });

  it("running worker pauses hot-path dispatches when a foreign migration lock appears", async () => {
    // Simulates the v2 → v3 upgrade scenario: v2 is happily running,
    // then a future v3 process sets the migration lock with
    // targetWireVersion=2. The v2 worker must stop touching the
    // keyspace until the lock clears — broadcast-triggered, not just
    // poll-triggered, so the pause happens instantly.
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("pause-test", async () => null);
    await app.ensureConnected();

    // Set the lock with targetWireVersion >= ours.
    const lockPayload = {
      by: "taskora-wire-99",
      reason: "test",
      startedAt: Date.now(),
      expectedDurationMs: 60_000,
      targetWireVersion: WIRE_VERSION + 1,
    };
    await redis.set("taskora:migration:lock", JSON.stringify(lockPayload), "PX", 60_000);
    // Broadcast so the backend reacts instantly without waiting for
    // the 30s safety-net poll.
    const pubRedis = new Redis(url());
    await pubRedis.publish("taskora:migration:broadcast", "halt");
    await pubRedis.quit();

    // Give the broadcast handler a tick to flip the flag.
    await new Promise((r) => setTimeout(r, 50));

    // Dispatch attempt during the pause — should block, not error out.
    let dispatchResolved = false;
    const dispatchPromise = (async () => {
      await task.dispatch({}).ensureEnqueued();
      dispatchResolved = true;
    })();

    await new Promise((r) => setTimeout(r, 200));
    expect(dispatchResolved).toBe(false);

    // Clear the lock + broadcast "done" — the dispatch should unblock.
    await redis.del("taskora:migration:lock");
    const pub2 = new Redis(url());
    await pub2.publish("taskora:migration:broadcast", "done");
    await pub2.quit();
    await dispatchPromise;
    expect(dispatchResolved).toBe(true);

    await app.close();
  });

  it("running worker IGNORES a foreign migration lock that only targets older versions", async () => {
    // Regression for the targetWireVersion filter: a lock with
    // targetWireVersion strictly LESS than ours means the migrator is
    // rewriting a format we're already past. We must NOT halt.
    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("pause-skip", async () => null);
    await app.ensureConnected();

    const lockPayload = {
      by: "taskora-wire-0",
      reason: "test",
      startedAt: Date.now(),
      expectedDurationMs: 60_000,
      targetWireVersion: WIRE_VERSION - 1,
    };
    await redis.set("taskora:migration:lock", JSON.stringify(lockPayload), "PX", 60_000);
    const pubRedis = new Redis(url());
    await pubRedis.publish("taskora:migration:broadcast", "halt");
    await pubRedis.quit();

    await new Promise((r) => setTimeout(r, 50));

    // Dispatch should go through immediately.
    const start = Date.now();
    await task.dispatch({}).ensureEnqueued();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(300);

    await redis.del("taskora:migration:lock");
    await app.close();
  });

  it("migrates a large-ish wait list (500 jobs) in one shot without timing out", async () => {
    // Stress guard against the per-key Lua script. 500 jobs gives ~1500
    // Redis calls inside the script (LRANGE + 500 HMGET + DEL + ZADD)
    // and finishes well under 100ms on a real instance.
    await seedV1Meta();
    const task = "migr-big";
    const pipe = redis.pipeline();
    for (let i = 0; i < 500; i++) {
      const jobKey = `taskora:{${task}}:j${i}`;
      pipe.hset(jobKey, {
        ts: String(Date.now() + i),
        _v: "1",
        attempt: "1",
        maxAttempts: "1",
        state: "waiting",
        priority: String(i % 3 === 0 ? 10 : 0),
      });
      pipe.set(`${jobKey}:data`, JSON.stringify({ n: i }));
      pipe.lpush(`taskora:{${task}}:wait`, `j${i}`);
    }
    await pipe.exec();

    const start = Date.now();
    const app = createTaskora({ adapter: redisAdapter(url()) });
    await app.ensureConnected();
    const elapsed = Date.now() - start;

    expect(await redis.type(`taskora:{${task}}:wait`)).toBe("zset");
    expect(await redis.zcard(`taskora:{${task}}:wait`)).toBe(500);
    // Should migrate quickly even for 500 jobs — generous bound to
    // avoid flakes under CI load.
    expect(elapsed).toBeLessThan(5000);

    await app.close();
  });
});
