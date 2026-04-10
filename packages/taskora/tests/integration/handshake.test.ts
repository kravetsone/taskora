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
    await redis.hset("taskora:meta", {
      wireVersion: "1",
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
