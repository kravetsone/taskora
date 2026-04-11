// Resilience tests — what happens when the Redis connection or server
// state gets yanked out from under a running adapter.
//
// Covers two classes of failure that users hit in production but that
// unit tests can't reach:
//
//   1. `SCRIPT FLUSH` (or server restart + empty script cache) — every
//      cached SHA becomes NOSCRIPT. The driver's EVAL-fallback path must
//      recover transparently so dispatches in flight after the flush
//      still land. Regression guard for the `evalSha → NOSCRIPT → eval +
//      re-LOAD` branch in `drivers/ioredis.ts` / `drivers/bun.ts`.
//
//   2. `CLIENT KILL TYPE normal` — severs every non-pubsub socket the
//      driver has open, including the blocking BZPOPMIN dequeue
//      connection. ioredis auto-reconnects; the worker's poll loop
//      swallows the error and retries. The invariant is that no job is
//      lost or double-processed across a kill.

import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTaskora } from "../../src/index.js";
import { isIoredis, redisAdapter } from "../create-adapter.js";
import { url, waitFor } from "../helpers.js";

let redis: Redis;

beforeEach(() => {
  redis = new Redis(url());
});

afterEach(async () => {
  await redis.flushdb();
  await redis.quit();
});

describe("NOSCRIPT fallback", () => {
  it("recovers after SCRIPT FLUSH mid-operation", async () => {
    // Baseline: start the app, run one job end-to-end so the backend
    // has loaded and cached every SHA.
    const processed: number[] = [];

    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("noscript-recover", async (data: { n: number }) => {
      processed.push(data.n);
      return { n: data.n };
    });

    await task.dispatch({ n: 1 });
    await app.start();
    await waitFor(() => processed.length === 1);

    // Wipe the server-side Lua cache out from under the backend. From
    // this point on every cached SHA the backend holds is stale, and
    // the very next EVALSHA will fail with NOSCRIPT.
    await redis.script("FLUSH");

    // New dispatch — must still be processed. The dispatch path hits
    // the `enqueue` Lua script, which is exactly the call that will
    // trigger the NOSCRIPT branch in `evalSha`.
    await task.dispatch({ n: 2 });
    await waitFor(() => processed.length === 2, 5_000);
    expect(processed).toEqual([1, 2]);

    // And the recovery path re-LOADs the script on success, so a
    // second post-flush dispatch should run on the warm cache again
    // (no extra EVAL fallback needed). We can't assert that from here
    // directly, but running a third job end-to-end proves the backend
    // is still functional.
    await task.dispatch({ n: 3 });
    await waitFor(() => processed.length === 3);
    expect(processed).toEqual([1, 2, 3]);

    await app.close();
  });

  it("recovers on the ack path too (not just enqueue)", async () => {
    // Enqueue and dequeue both hit Lua. A previous version of this
    // file only flushed before dispatch, which only exercised one
    // script's NOSCRIPT branch. This test flushes AFTER a job has
    // already been claimed — the ack Lua will then NOSCRIPT.
    let holdResolve: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      holdResolve = resolve;
    });

    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("noscript-ack-recover", async () => {
      // Pause inside the handler long enough for the test to run
      // SCRIPT FLUSH before we return (and before ack.lua runs).
      await gate;
      return { ok: true };
    });

    const handle = task.dispatch({});
    await app.start();

    // Wait until the job is active (dequeue.lua has run and cached).
    await waitFor(async () => (await handle.getState()) === "active");

    // Flush — the ack script's SHA is now stale.
    await redis.script("FLUSH");

    // Release the handler. Worker calls ack → NOSCRIPT → EVAL fallback
    // → job transitions to completed.
    holdResolve?.();

    const result = await handle.waitFor(5_000);
    expect(result).toEqual({ ok: true });

    await app.close();
  });
});

// ── Connection loss ───────────────────────────────────────────────────
//
// `CLIENT KILL TYPE normal` severs every normal (non-pubsub) connection
// the driver owns. The main command connection and the blocking
// BZPOPMIN/XREAD duplicates all die simultaneously. ioredis handles
// reconnection internally; the test asserts that the user-visible
// contract survives — dispatches land, jobs process, no duplicates.
//
// Skipped under the Bun driver: `Bun.RedisClient` does not currently
// expose the same auto-reconnect behavior ioredis does for duplicated
// blocking connections. The kill test below would surface as flakiness
// rather than a genuine taskora regression, so we gate it on isIoredis.

describe.skipIf(!isIoredis)("connection loss (ioredis)", () => {
  it("jobs dispatched AFTER CLIENT KILL still process", async () => {
    const processed: number[] = [];

    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("kill-after-dispatch", async (data: { n: number }) => {
      processed.push(data.n);
      return null;
    });

    // Warm up: one job through the pipeline so all ioredis duplicate
    // connections (dequeue blocker, event reader, pub/sub) are live.
    await task.dispatch({ n: 1 });
    await app.start();
    await waitFor(() => processed.length === 1);

    // Kill every normal connection on the server. Pub/sub
    // subscriptions survive (TYPE pubsub) so the cancel/event channel
    // stays up; the BZPOPMIN duplicate and the main command socket go
    // down. ioredis reconnects both; the worker's poll loop swallows
    // the transient error and retries.
    await redis.call("CLIENT", "KILL", "TYPE", "normal");

    // Give the driver a beat to notice the drop and reconnect. Without
    // this, the very next dispatch would race the reconnect and could
    // resolve against a half-closed socket.
    await new Promise((r) => setTimeout(r, 200));

    await task.dispatch({ n: 2 });
    await waitFor(() => processed.length === 2, 10_000);
    expect(processed).toEqual([1, 2]);

    // And the worker is still polling — a third job arrives cleanly.
    await task.dispatch({ n: 3 });
    await waitFor(() => processed.length === 3, 10_000);
    expect(processed).toEqual([1, 2, 3]);

    await app.close();
  });

  it("no duplicate processing across a CLIENT KILL between active jobs", async () => {
    // The invariant under test: a job that is fully acked BEFORE the
    // kill must NOT reappear after the kill. This is the class of bug
    // where a reconnecting worker's internal state disagrees with
    // Redis state about which jobs are terminal.
    const seen = new Map<number, number>();

    const app = createTaskora({ adapter: redisAdapter(url()) });
    const task = app.task("kill-no-dup", {
      concurrency: 1,
      handler: async (data: { n: number }) => {
        seen.set(data.n, (seen.get(data.n) ?? 0) + 1);
        return null;
      },
    });

    await Promise.all([
      task.dispatch({ n: 1 }).ensureEnqueued(),
      task.dispatch({ n: 2 }).ensureEnqueued(),
      task.dispatch({ n: 3 }).ensureEnqueued(),
    ]);
    await app.start();
    await waitFor(() => seen.size === 3);

    // Every job is done and acked. Now sever the sockets.
    await redis.call("CLIENT", "KILL", "TYPE", "normal");
    await new Promise((r) => setTimeout(r, 200));

    // Push two more jobs through the reconnected plumbing.
    await task.dispatch({ n: 4 });
    await task.dispatch({ n: 5 });
    await waitFor(() => seen.size === 5, 10_000);

    // Every job seen exactly once — no replays from the pre-kill set,
    // no doubled post-kill claims.
    for (const [n, count] of seen.entries()) {
      expect(count, `job n=${n} processed ${count} times`).toBe(1);
    }

    await app.close();
  });
});
