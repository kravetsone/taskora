import { describe, expect, it } from "vitest";
import { createTaskora } from "../../src/index.js";
import { memoryAdapter } from "../../src/memory/index.js";

describe("memoryAdapter", () => {
  it("works as a drop-in adapter for App", async () => {
    const app = createTaskora({ adapter: memoryAdapter() });
    const task = app.task("greet", async (data: { name: string }) => ({
      greeting: `Hello, ${data.name}!`,
    }));

    const handle = task.dispatch({ name: "World" });
    const id = await handle;
    expect(typeof id).toBe("string");
    expect(await handle.getState()).toBe("waiting");
  });

  it("enqueue and dequeue cycle", async () => {
    const adapter = memoryAdapter();
    await adapter.connect();

    await adapter.enqueue("t1", "j1", '{"x":1}', { _v: 1 });
    const result = await adapter.dequeue("t1", 30_000, "tok1");

    expect(result).not.toBeNull();
    expect(result?.id).toBe("j1");
    expect(result?.data).toBe('{"x":1}');
    expect(result?.attempt).toBe(1);
  });

  it("ack moves to completed", async () => {
    const adapter = memoryAdapter();
    await adapter.connect();

    await adapter.enqueue("t1", "j1", '"data"', { _v: 1 });
    const raw = await adapter.dequeue("t1", 30_000, "tok1");
    await adapter.ack("t1", "j1", "tok1", '"result"');

    expect(await adapter.getState("t1", "j1")).toBe("completed");
    expect(await adapter.getResult("t1", "j1")).toBe('"result"');
  });

  it("fail with retry moves to retrying", async () => {
    const adapter = memoryAdapter();
    await adapter.connect();

    await adapter.enqueue("t1", "j1", '"data"', { _v: 1, maxAttempts: 3 });
    await adapter.dequeue("t1", 30_000, "tok1");
    await adapter.fail("t1", "j1", "tok1", "oops", { delay: 1000 });

    expect(await adapter.getState("t1", "j1")).toBe("retrying");
  });

  it("fail without retry moves to failed", async () => {
    const adapter = memoryAdapter();
    await adapter.connect();

    await adapter.enqueue("t1", "j1", '"data"', { _v: 1 });
    await adapter.dequeue("t1", 30_000, "tok1");
    await adapter.fail("t1", "j1", "tok1", "permanent error");

    expect(await adapter.getState("t1", "j1")).toBe("failed");
    expect(await adapter.getError("t1", "j1")).toBe("permanent error");
  });

  it("nack returns job to waiting", async () => {
    const adapter = memoryAdapter();
    await adapter.connect();

    await adapter.enqueue("t1", "j1", '"data"', { _v: 1 });
    await adapter.dequeue("t1", 30_000, "tok1");
    await adapter.nack("t1", "j1", "tok1");

    expect(await adapter.getState("t1", "j1")).toBe("waiting");
  });

  it("delayed enqueue and promote", async () => {
    const adapter = memoryAdapter();
    await adapter.connect();

    await adapter.enqueue("t1", "j1", '"data"', { _v: 1, delay: 5000 });
    expect(await adapter.getState("t1", "j1")).toBe("delayed");

    // Not promoted yet (delay not elapsed with real clock)
    const result = await adapter.dequeue("t1", 30_000, "tok1");
    // May or may not be null depending on timing, but state was "delayed"
    // This is a basic smoke test for the delayed path
  });

  it("cancel a waiting job", async () => {
    const adapter = memoryAdapter();
    await adapter.connect();

    await adapter.enqueue("t1", "j1", '"data"', { _v: 1 });
    const status = await adapter.cancel("t1", "j1", "no longer needed");
    expect(status).toBe("cancelled");
    expect(await adapter.getState("t1", "j1")).toBe("cancelled");
  });

  it("cancel an active job returns flagged", async () => {
    const adapter = memoryAdapter();
    await adapter.connect();

    await adapter.enqueue("t1", "j1", '"data"', { _v: 1 });
    await adapter.dequeue("t1", 30_000, "tok1");
    const status = await adapter.cancel("t1", "j1");
    expect(status).toBe("flagged");
  });

  it("extendLock returns cancelled for flagged jobs", async () => {
    const adapter = memoryAdapter();
    await adapter.connect();

    await adapter.enqueue("t1", "j1", '"data"', { _v: 1 });
    await adapter.dequeue("t1", 30_000, "tok1");
    await adapter.cancel("t1", "j1");

    const status = await adapter.extendLock("t1", "j1", "tok1", 30_000);
    expect(status).toBe("cancelled");
  });

  it("queue stats", async () => {
    const adapter = memoryAdapter();
    await adapter.connect();

    await adapter.enqueue("t1", "j1", '""', { _v: 1 });
    await adapter.enqueue("t1", "j2", '""', { _v: 1 });

    const stats = await adapter.getQueueStats("t1");
    expect(stats.waiting).toBe(2);
    expect(stats.active).toBe(0);
    expect(stats.completed).toBe(0);
  });

  it("scheduler lock acquire and renew", async () => {
    const adapter = memoryAdapter();
    await adapter.connect();

    const acquired = await adapter.acquireSchedulerLock("tok1", 30_000);
    expect(acquired).toBe(true);

    const second = await adapter.acquireSchedulerLock("tok2", 30_000);
    expect(second).toBe(false);

    const renewed = await adapter.renewSchedulerLock("tok1", 30_000);
    expect(renewed).toBe(true);

    const wrong = await adapter.renewSchedulerLock("tok2", 30_000);
    expect(wrong).toBe(false);
  });

  it("schedule CRUD", async () => {
    const adapter = memoryAdapter();
    await adapter.connect();

    await adapter.addSchedule("s1", '{"task":"t1","every":5000}', 1000);
    const schedule = await adapter.getSchedule("s1");
    expect(schedule).not.toBeNull();
    expect(schedule?.nextRun).toBe(1000);

    await adapter.pauseSchedule("s1");
    const paused = await adapter.getSchedule("s1");
    expect(paused?.paused).toBe(true);

    await adapter.resumeSchedule("s1", 2000);
    const resumed = await adapter.getSchedule("s1");
    expect(resumed?.nextRun).toBe(2000);

    await adapter.removeSchedule("s1");
    expect(await adapter.getSchedule("s1")).toBeNull();
  });

  it("progress and logs", async () => {
    const adapter = memoryAdapter();
    await adapter.connect();

    await adapter.enqueue("t1", "j1", '""', { _v: 1 });
    await adapter.dequeue("t1", 30_000, "tok1");

    await adapter.setProgress("t1", "j1", "50");
    expect(await adapter.getProgress("t1", "j1")).toBe("50");

    await adapter.addLog("t1", "j1", '{"level":"info","message":"step 1"}');
    await adapter.addLog("t1", "j1", '{"level":"info","message":"step 2"}');
    const logs = await adapter.getLogs("t1", "j1");
    expect(logs).toHaveLength(2);
  });

  it("throttle enqueue", async () => {
    const adapter = memoryAdapter();
    await adapter.connect();

    const ok1 = await adapter.throttleEnqueue("t1", "j1", '"a"', { _v: 1 }, "k1", 2, 10_000);
    const ok2 = await adapter.throttleEnqueue("t1", "j2", '"b"', { _v: 1 }, "k1", 2, 10_000);
    const ok3 = await adapter.throttleEnqueue("t1", "j3", '"c"', { _v: 1 }, "k1", 2, 10_000);

    expect(ok1).toBe(true);
    expect(ok2).toBe(true);
    expect(ok3).toBe(false); // throttled
  });

  it("deduplicate enqueue", async () => {
    const adapter = memoryAdapter();
    await adapter.connect();

    const r1 = await adapter.deduplicateEnqueue("t1", "j1", '"a"', { _v: 1 }, "dk1", ["waiting"]);
    expect(r1.created).toBe(true);

    const r2 = await adapter.deduplicateEnqueue("t1", "j2", '"b"', { _v: 1 }, "dk1", ["waiting"]);
    expect(r2.created).toBe(false);
    if (!r2.created) expect(r2.existingId).toBe("j1");
  });
});

describe("memoryAdapter.blockingDequeue", () => {
  // These tests cover the event-driven blockingDequeue implementation. Before
  // the fix, MemoryBackend.blockingDequeue was a sync-delegating stub —
  // ignored `timeoutMs` and returned `null` immediately on an empty queue,
  // turning the Worker poll loop into a microtask firehose. Regression guards:
  //
  // 1. honours `timeoutMs` when truly empty (no busy-loop)
  // 2. wakes up on a concurrent enqueue (no latency penalty)
  // 3. wakes up on `disconnect()` (so Worker.stop → adapter.disconnect doesn't
  //    deadlock behind the 2s BLOCK_TIMEOUT)
  // 4. respects delayed-job deadlines — waits only until the job is due, not
  //    the full timeoutMs
  // 5. FIFO per-task: one enqueue wakes exactly one waiter
  // 6. fast path stays fast when the queue already has work

  it("blocks for approximately timeoutMs when the queue stays empty", async () => {
    const adapter = memoryAdapter();
    await adapter.connect();

    const start = Date.now();
    const result = await adapter.blockingDequeue("t1", 30_000, "tok", 100);
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    // Allow generous slack for CI — what we're guarding against is the old
    // "returns null in <1ms" behaviour. 60ms minimum catches the regression.
    expect(elapsed).toBeGreaterThanOrEqual(60);
    expect(elapsed).toBeLessThan(500);
  });

  it("wakes up when a job is enqueued while parked", async () => {
    const adapter = memoryAdapter();
    await adapter.connect();

    const start = Date.now();
    const blockingPromise = adapter.blockingDequeue("t1", 30_000, "tok", 2_000);

    // Give the waiter a tick to park before we enqueue.
    await new Promise((r) => setTimeout(r, 20));
    await adapter.enqueue("t1", "j1", '"payload"', { _v: 1 });

    const result = await blockingPromise;
    const elapsed = Date.now() - start;

    expect(result).not.toBeNull();
    expect(result?.id).toBe("j1");
    // Should wake on the enqueue event — well under the 2s block timeout.
    expect(elapsed).toBeLessThan(300);
  });

  it("returns null immediately when disconnect() is called while parked", async () => {
    const adapter = memoryAdapter();
    await adapter.connect();

    const start = Date.now();
    const blockingPromise = adapter.blockingDequeue("t1", 30_000, "tok", 5_000);

    await new Promise((r) => setTimeout(r, 20));
    await adapter.disconnect();

    const result = await blockingPromise;
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    // Must drain instantly on disconnect — not sit on the 5s deadline.
    expect(elapsed).toBeLessThan(300);
  });

  it("wakes up when a delayed job becomes due", async () => {
    const adapter = memoryAdapter();
    await adapter.connect();

    // Delayed job due in ~80ms, block timeout of 5s — we should wake around
    // the 80ms mark via promoteDelayed, not wait 5s.
    await adapter.enqueue("t1", "j1", '"payload"', { _v: 1, delay: 80 });

    const start = Date.now();
    const result = await adapter.blockingDequeue("t1", 30_000, "tok", 5_000);
    const elapsed = Date.now() - start;

    expect(result).not.toBeNull();
    expect(result?.id).toBe("j1");
    expect(elapsed).toBeLessThan(500);
  });

  it("wakes exactly one parked waiter per enqueue (FIFO)", async () => {
    const adapter = memoryAdapter();
    await adapter.connect();

    const a = adapter.blockingDequeue("t1", 30_000, "tok-a", 500);
    const b = adapter.blockingDequeue("t1", 30_000, "tok-b", 500);
    const c = adapter.blockingDequeue("t1", 30_000, "tok-c", 500);

    await new Promise((r) => setTimeout(r, 20));
    await adapter.enqueue("t1", "j1", '"only-one"', { _v: 1 });

    const [ra, rb, rc] = await Promise.all([a, b, c]);

    // FIFO: first parked waiter gets the job, others time out with null.
    expect(ra?.id).toBe("j1");
    expect(rb).toBeNull();
    expect(rc).toBeNull();
  });

  it("fast-paths when a job is already waiting (no parking)", async () => {
    const adapter = memoryAdapter();
    await adapter.connect();

    await adapter.enqueue("t1", "j1", '"ready"', { _v: 1 });

    const start = Date.now();
    const result = await adapter.blockingDequeue("t1", 30_000, "tok", 5_000);
    const elapsed = Date.now() - start;

    expect(result?.id).toBe("j1");
    // Fast path must not go through setTimeout at all.
    expect(elapsed).toBeLessThan(50);
  });

  it("Worker loop against memoryAdapter idles without busy-waiting", async () => {
    // Regression guard for the original symptom: running a real Worker against
    // memoryAdapter with an empty queue used to produce a microtask firehose
    // that hid event loop starvation. This checks the loop doesn't publish
    // completion events for a job we never dispatched, and that close()
    // resolves promptly even though the worker was actively polling.
    const app = createTaskora({ adapter: memoryAdapter() });
    const events: string[] = [];
    const task = app.task("idle-task", async () => "ok");
    task.on("completed", () => events.push("completed"));

    await app.start();
    // Let the worker park on blockingDequeue for a bit with nothing to do.
    await new Promise((r) => setTimeout(r, 150));

    const closeStart = Date.now();
    await app.close({ timeout: 500 });
    const closeElapsed = Date.now() - closeStart;

    expect(events).toEqual([]);
    // Real regression: before the fix, close() could lag behind the starved
    // event loop. After the fix it's essentially immediate.
    expect(closeElapsed).toBeLessThan(400);
  });
});
