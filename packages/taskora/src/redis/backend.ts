import { SchemaVersionMismatchError } from "../errors.js";
import type { Taskora } from "../types.js";
import { WIRE_VERSION, checkCompat, currentMeta } from "../wire-version.js";
import type { RedisDriver } from "./driver.js";
import { EventReader } from "./event-reader.js";
import { JobWaiter } from "./job-waiter.js";
import {
  type MigrationLockPayload,
  buildKeys,
  buildMetaKey,
  buildMigrationKeys,
  buildScheduleKeys,
} from "./keys.js";
import * as scripts from "./scripts.js";
import * as wfScripts from "./workflow-scripts.js";

// Hard cap on entries kept in a single job's `:logs` list. `addLog()` pairs
// every RPUSH with an `LTRIM -N -1` so a runaway handler (tight loop +
// `ctx.log.info`) can't balloon one list to hundreds of MB before the retention
// sweep finally deletes the whole key on job completion. The cap is generous
// by design — real jobs should need far fewer, and the LTRIM is an O(1)
// no-op when the list is already below the limit.
const MAX_LOGS_PER_JOB = 10_000;

const SCRIPT_MAP: Record<string, string> = {
  enqueue: scripts.ENQUEUE,
  enqueueDelayed: scripts.ENQUEUE_DELAYED,
  enqueueBulk: scripts.ENQUEUE_BULK,
  moveToActive: scripts.MOVE_TO_ACTIVE,
  ack: scripts.ACK,
  ackAndMoveToActive: scripts.ACK_AND_MOVE_TO_ACTIVE,
  fail: scripts.FAIL,
  failAndMoveToActive: scripts.FAIL_AND_MOVE_TO_ACTIVE,
  nack: scripts.NACK,
  stalledCheck: scripts.STALLED_CHECK,
  extendLock: scripts.EXTEND_LOCK,
  tickScheduler: scripts.TICK_SCHEDULER,
  acquireSchedulerLock: scripts.ACQUIRE_SCHEDULER_LOCK,
  renewSchedulerLock: scripts.RENEW_SCHEDULER_LOCK,
  versionDistribution: scripts.VERSION_DISTRIBUTION,
  listJobDetails: scripts.LIST_JOB_DETAILS,
  retryDLQ: scripts.RETRY_DLQ,
  retryAllDLQ: scripts.RETRY_ALL_DLQ,
  trimDLQ: scripts.TRIM_DLQ,
  debounce: scripts.DEBOUNCE,
  throttleEnqueue: scripts.THROTTLE_ENQUEUE,
  deduplicateEnqueue: scripts.DEDUPLICATE_ENQUEUE,
  collectPush: scripts.COLLECT_PUSH,
  cancel: scripts.CANCEL,
  finishCancel: scripts.FINISH_CANCEL,
  createWorkflow: wfScripts.CREATE_WORKFLOW,
  advanceWorkflow: wfScripts.ADVANCE_WORKFLOW,
  failWorkflow: wfScripts.FAIL_WORKFLOW,
  cancelWorkflow: wfScripts.CANCEL_WORKFLOW,
  cleanJobs: scripts.CLEAN_JOBS,
  handshake: scripts.HANDSHAKE,
  migrateWaitV1ToV2: scripts.MIGRATE_WAIT_V1_TO_V2,
  migrateWaitV4ToV5: scripts.MIGRATE_WAIT_V4_TO_V5,
};

export class RedisBackend implements Taskora.Adapter {
  private driver: RedisDriver;
  private ownsDriver: boolean;
  private prefix?: string;
  private shas = new Map<string, string>();
  private jobWaiter: JobWaiter | null = null;
  private blockingClients = new Map<string, RedisDriver>();
  private connected = false;

  // ── Migration pause state ─────────────────────────────────────────
  //
  // When a foreign taskora process sets `taskora:<prefix>:migration:lock`
  // with a `targetWireVersion >= ours`, we MUST stop touching the shared
  // keyspace for the duration of the migration. These fields track that
  // state and let every `eval()` block on it from the hot path.
  //
  // `migrationPaused` is flipped by the broadcast-channel listener
  // and by a periodic safety-net poll. `migrationWake` is the resolver
  // of the current pause promise — it fires when the flag flips back
  // to false so any awaiting call resumes immediately instead of
  // polling.
  private migrationPaused = false;
  private migrationWake: (() => void) | null = null;
  private migrationPausePromise: Promise<void> | null = null;
  private migrationSubDriver: RedisDriver | null = null;
  private migrationUnsubscribe: (() => Promise<void>) | null = null;
  private migrationPollTimer: ReturnType<typeof setInterval> | null = null;
  // Sticky failure set after a foreign migration completed against a
  // wire version we don't understand. Once set, every hot-path `eval()`
  // call throws this instead of running — our cached Lua SHAs point at
  // scripts that would corrupt the new format if they ran, so the
  // only correct action is loud failure until the process is restarted
  // on a newer taskora build. Never cleared (deliberately — the
  // operator must redeploy).
  private migrationIncompatibleError: SchemaVersionMismatchError | null = null;

  constructor(options: { driver: RedisDriver; ownsDriver: boolean; prefix?: string }) {
    this.driver = options.driver;
    this.ownsDriver = options.ownsDriver;
    this.prefix = options.prefix;
  }

  async connect(): Promise<void> {
    await this.driver.connect();
    this.connected = true;
    await this.loadScripts();
    await this.startMigrationListener();
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.stopMigrationListener();
    // Blocking clients are stuck in BZPOPMIN — must force-disconnect, NOT
    // graceful close, or shutdown hangs up to the full block timeout.
    for (const client of this.blockingClients.values()) {
      await client.disconnect();
    }
    this.blockingClients.clear();
    if (this.jobWaiter) {
      await this.jobWaiter.shutdown();
      this.jobWaiter = null;
    }
    if (this.ownsDriver) {
      await this.driver.close();
    }
  }

  /**
   * Subscribe to the reserved `migration:broadcast` channel and start
   * a periodic safety-net poll against the `migration:lock` key. Any
   * time a foreign migrator sets the lock with a `targetWireVersion`
   * covering ours, we flip `migrationPaused = true` so every subsequent
   * `eval()` on the hot path blocks until the lock clears.
   *
   * Called from `connect()`. The subscribe uses a duplicated driver so
   * the main connection doesn't enter Redis subscriber mode (which
   * would forbid every other command). Failures are non-fatal — if
   * subscribe throws (very old Redis, missing perms, etc.) we fall
   * back to the periodic poll alone.
   */
  private async startMigrationListener(): Promise<void> {
    const { migrationChannel } = buildMigrationKeys(this.prefix);

    try {
      this.migrationSubDriver = await this.driver.duplicate();
      this.migrationUnsubscribe = await this.migrationSubDriver.subscribe(migrationChannel, () => {
        // Any broadcast message is a hint to re-check the lock. We
        // intentionally ignore the payload content — future migrators
        // may put anything in there.
        this.refreshMigrationState().catch(() => {
          // Broadcast-triggered refresh is best-effort; the periodic
          // poll will retry.
        });
      });
    } catch {
      this.migrationSubDriver = null;
      this.migrationUnsubscribe = null;
    }

    // Safety net: poll every 30 s even if pub/sub works, so a missed
    // message (e.g. we were reconnecting when the migrator PUBLISHed)
    // can't pin us in the wrong state forever. Seed with an immediate
    // check so a process starting mid-migration notices right away.
    await this.refreshMigrationState();
    this.migrationPollTimer = setInterval(() => {
      this.refreshMigrationState().catch(() => {
        // Poll failure is non-fatal; next tick retries.
      });
    }, 30_000);
    if (typeof this.migrationPollTimer.unref === "function") {
      this.migrationPollTimer.unref();
    }
  }

  private async stopMigrationListener(): Promise<void> {
    if (this.migrationPollTimer) {
      clearInterval(this.migrationPollTimer);
      this.migrationPollTimer = null;
    }
    if (this.migrationUnsubscribe) {
      try {
        await this.migrationUnsubscribe();
      } catch {
        // ignored
      }
      this.migrationUnsubscribe = null;
    }
    if (this.migrationSubDriver) {
      try {
        await this.migrationSubDriver.disconnect();
      } catch {
        // ignored
      }
      this.migrationSubDriver = null;
    }
    // Release anyone still parked on migrationPausePromise — on shutdown
    // we want them to unblock and exit, not hang.
    if (this.migrationWake) {
      this.migrationWake();
      this.migrationWake = null;
      this.migrationPausePromise = null;
    }
    this.migrationPaused = false;
  }

  /**
   * Read the current migration lock and update `migrationPaused` to
   * match. Called from three places: initial connect, every broadcast
   * message, and the periodic safety-net poll. Idempotent — calling
   * it multiple times concurrently is safe.
   */
  private async refreshMigrationState(): Promise<void> {
    const { migrationLock } = buildMigrationKeys(this.prefix);
    const ourWireVersion = this.ourWireVersion;

    let shouldPause = false;
    try {
      const raw = (await this.driver.command("get", [migrationLock])) as string | null;
      if (raw !== null) {
        let targetVersion = Number.POSITIVE_INFINITY;
        try {
          const parsed = JSON.parse(raw) as Partial<MigrationLockPayload>;
          if (typeof parsed.targetWireVersion === "number") {
            targetVersion = parsed.targetWireVersion;
          }
        } catch {
          // malformed → halt everyone (fail safe)
        }
        if (ourWireVersion <= targetVersion) {
          shouldPause = true;
        }
      }
    } catch {
      // If the GET itself fails (network blip) don't flip state — the
      // next poll will retry. Assume current state remains valid.
      return;
    }

    if (shouldPause && !this.migrationPaused) {
      this.migrationPaused = true;
      this.migrationPausePromise = new Promise((resolve) => {
        this.migrationWake = resolve;
      });
      // biome-ignore lint/suspicious/noConsole: operator-visible coordination signal
      console.log(
        "[taskora] foreign migration detected — pausing hot-path Redis ops until it clears",
      );
    } else if (!shouldPause && this.migrationPaused) {
      // Pause is about to lift — but BEFORE we let hot-path callers
      // resume, verify that the backend still speaks a wire version
      // our cached Lua SHAs are actually compatible with. A foreign
      // migration may have bumped stored meta past us, and running
      // our old scripts against the new format would corrupt data.
      //
      // If compat still holds (the migrator only targeted older
      // versions, or this was a false alarm from a crashed migrator
      // whose lock expired), resume normally. If compat is broken,
      // latch an incompatible error so every subsequent `eval()`
      // throws — the process effectively halts until the operator
      // restarts on a newer build.
      const compatError = await this.checkPostMigrationCompat();
      if (compatError) {
        this.migrationIncompatibleError = compatError;
        // biome-ignore lint/suspicious/noConsole: fatal operator-facing error
        console.error(
          `[taskora] foreign migration completed but left the backend on a wire version we cannot read (${compatError.message}). Halting hot-path Redis ops — restart this process on a compatible taskora build.`,
        );
        // Fire wake so currently-parked callers get their throw; leave
        // `migrationPaused = true` so future callers don't race past
        // the check. Callers see the sticky error via `waitForMigration`.
        if (this.migrationWake) {
          this.migrationWake();
          this.migrationWake = null;
        }
        this.migrationPausePromise = null;
        return;
      }
      this.migrationPaused = false;
      if (this.migrationWake) {
        this.migrationWake();
        this.migrationWake = null;
      }
      this.migrationPausePromise = null;
      // biome-ignore lint/suspicious/noConsole: operator-visible coordination signal
      console.log("[taskora] foreign migration cleared — resuming hot-path Redis ops");
    }
  }

  /**
   * Read stored meta via direct HMGET (bypassing the HANDSHAKE Lua so
   * we don't accidentally re-initialize it) and run the normal
   * `checkCompat` verdict against our compiled constants. Returns
   * `null` if still compatible, or a constructed
   * `SchemaVersionMismatchError` ready to throw if not.
   */
  private async checkPostMigrationCompat(): Promise<SchemaVersionMismatchError | null> {
    try {
      const metaKey = buildMetaKey(this.prefix);
      const raw = (await this.driver.command("hmget", [
        metaKey,
        "wireVersion",
        "minCompat",
        "writtenBy",
        "writtenAt",
      ])) as (string | null)[];
      const theirs: Taskora.SchemaMeta = {
        wireVersion: Number(raw[0] ?? 0),
        minCompat: Number(raw[1] ?? 0),
        writtenBy: raw[2] ?? "",
        writtenAt: Number(raw[3] ?? 0),
      };
      const ours = currentMeta();
      const verdict = checkCompat(ours, theirs);
      if (verdict.ok) return null;
      return new SchemaVersionMismatchError(
        verdict.code,
        verdict.message,
        { wireVersion: ours.wireVersion, minCompat: ours.minCompat, writtenBy: ours.writtenBy },
        {
          wireVersion: theirs.wireVersion,
          minCompat: theirs.minCompat,
          writtenBy: theirs.writtenBy,
          writtenAt: theirs.writtenAt,
        },
      );
    } catch {
      // If the HMGET itself fails (network blip), don't latch an
      // incompatible error — we don't know the truth. The next
      // broadcast/poll cycle will retry.
      return null;
    }
  }

  /** Wire version this build understands. */
  private get ourWireVersion(): number {
    return WIRE_VERSION;
  }

  /**
   * Await the migration pause clearing. Returns immediately in the
   * common case (no migration in progress). During a foreign
   * migration this is what keeps workers out of the keyspace — the
   * `eval()` method calls it for every non-internal script name.
   *
   * If a foreign migration ended with the backend on a wire version
   * we don't understand, this throws `SchemaVersionMismatchError` —
   * every parked caller gets the same error, every subsequent
   * `eval()` call gets it synchronously (via the same sticky flag),
   * and the worker / app layer can treat it as a fatal signal.
   */
  private async waitForMigration(): Promise<void> {
    if (this.migrationIncompatibleError) throw this.migrationIncompatibleError;
    while (this.migrationPaused && this.migrationPausePromise) {
      await this.migrationPausePromise;
      if (this.migrationIncompatibleError) throw this.migrationIncompatibleError;
    }
  }

  async handshake(ours: Taskora.SchemaMeta): Promise<Taskora.SchemaMeta> {
    // Migration coordination gate. If another process is currently
    // running a migration targeting a wire version >= ours, we halt
    // here until it clears. If a more recent migration is in flight
    // that only targets older versions (targetWireVersion < ours.wireVersion),
    // we proceed — we already understand whatever format the migrator
    // is producing. See `buildMigrationKeys` in keys.ts for the
    // contract that every in-place migration (current and future)
    // follows.
    await this.awaitMigrationLock(ours.wireVersion);

    const metaKey = buildMetaKey(this.prefix);
    const raw = (await this.eval(
      "handshake",
      1,
      metaKey,
      String(ours.wireVersion),
      String(ours.minCompat),
      ours.writtenBy,
      String(ours.writtenAt),
    )) as [string, string, string, string];

    const stored: Taskora.SchemaMeta = {
      wireVersion: Number(raw[0]),
      minCompat: Number(raw[1]),
      writtenBy: raw[2] || "",
      writtenAt: Number(raw[3]),
    };

    // Auto-migration: if the backend is on wireVersion 1 and we're v2+,
    // run the in-place wait-list migrator before anything touches the
    // adapter. Uses the shared migration-lock protocol so a cluster of
    // v2 instances starting simultaneously doesn't race — exactly one
    // wins the lock and performs the migration, the losers fall back
    // through `awaitMigrationLock` and re-handshake (now reading the
    // freshly-bumped v2 meta, taking the fast path).
    if (stored.wireVersion === 1 && ours.wireVersion >= 2) {
      return this.runInPlaceMigration(ours, metaKey, stored, () => this.migrateWaitV1ToV2());
    }

    // Auto-migration: wireVersion 4 → 5 splits the single wait ZSET
    // into a LIST (priority=0 fast path) + a separate prioritized
    // ZSET. Same shared-lock protocol as v1→v2.
    if (stored.wireVersion === 4 && ours.wireVersion >= 5) {
      return this.runInPlaceMigration(ours, metaKey, stored, () => this.migrateWaitV4ToV5());
    }

    // The Lua script normalizes every slot to a string; core's `checkCompat`
    // will flag any NaN/out-of-range values as `invalid_meta` so operators
    // get a clear error instead of a silent zero.
    return stored;
  }

  /**
   * Shared plumbing for in-place wait-queue migrations: acquire the
   * reserved migration lock, run the provided migrator, update the
   * meta hash, release the lock, broadcast. Losing races fall back
   * through `awaitMigrationLock` via a recursive `handshake()` call.
   */
  private async runInPlaceMigration(
    ours: Taskora.SchemaMeta,
    metaKey: string,
    stored: Taskora.SchemaMeta,
    run: () => Promise<{ keys: number; jobs: number }>,
  ): Promise<Taskora.SchemaMeta> {
    const lockKey = buildMigrationKeys(this.prefix).migrationLock;
    const payload: MigrationLockPayload = {
      by: ours.writtenBy,
      reason: `wireVersion-${stored.wireVersion}-to-${ours.wireVersion}`,
      startedAt: Date.now(),
      expectedDurationMs: 5 * 60_000,
      targetWireVersion: ours.wireVersion,
    };
    const ttlMs = 10 * 60_000;
    const acquired = (await this.driver.command("set", [
      lockKey,
      JSON.stringify(payload),
      "NX",
      "PX",
      String(ttlMs),
    ])) as "OK" | null;

    if (acquired !== "OK") {
      // Another process beat us to it — wait and re-handshake.
      return this.handshake(ours);
    }

    try {
      const migrated = await run();
      await this.driver.command("hset", [
        metaKey,
        "wireVersion",
        String(ours.wireVersion),
        "minCompat",
        String(ours.minCompat),
        "writtenBy",
        ours.writtenBy,
        "writtenAt",
        String(ours.writtenAt),
      ]);
      // biome-ignore lint/suspicious/noConsole: one-shot operator-visible upgrade signal
      console.log(
        `[taskora] migrated ${migrated.keys} :wait structure${migrated.keys === 1 ? "" : "s"} (${migrated.jobs} jobs) to wireVersion ${ours.wireVersion}`,
      );
    } finally {
      await this.driver.command("del", [lockKey]);
      const { migrationChannel } = buildMigrationKeys(this.prefix);
      try {
        await this.driver.command("publish", [migrationChannel, "migration:done"]);
      } catch {
        // PUBLISH failure is non-fatal.
      }
    }
    return { ...ours };
  }

  /**
   * wireVersion 1 → 2 migration: convert every `taskora:*:wait` LIST
   * into a ZSET keyed by the composite priority/ts score. Safe to run
   * against a live Redis (atomic per-key via Lua) and idempotent —
   * already-migrated keys are no-ops. See `scripts.MIGRATE_WAIT_V1_TO_V2`.
   *
   * Pacing: uses `SCAN` so the keyspace walk never blocks Redis, and
   * invokes one Lua script per matched key so the per-key conversion
   * window is bounded by that single task's wait-list size. Two tasks
   * are never batched into the same script — a huge task does not
   * hold Redis hostage while small ones pile up behind it.
   *
   * @internal — exposed for tests; production code goes through handshake().
   */
  async migrateWaitV1ToV2(): Promise<{ keys: number; jobs: number }> {
    const pattern = this.prefix ? `taskora:${this.prefix}:{*}:wait` : "taskora:{*}:wait";
    let cursor = "0";
    let keys = 0;
    let jobs = 0;

    do {
      // SCAN COUNT is a hint, not a cap — Redis returns up to ~COUNT keys
      // per call but may return fewer. 100 is a good tradeoff between
      // round-trip count and single-call latency.
      const result = (await this.driver.command("scan", [
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        "100",
      ])) as [string, string[]];
      cursor = result[0];
      const waitKeys = result[1] ?? [];

      for (const waitKey of waitKeys) {
        // Derive the jobPrefix for this task by stripping the ":wait"
        // suffix. The script needs it to HMGET each job's priority/ts.
        const jobPrefix = waitKey.slice(0, -"wait".length);
        const migrated = (await this.eval("migrateWaitV1ToV2", 1, waitKey, jobPrefix)) as number;
        if (migrated > 0) {
          keys += 1;
          jobs += migrated;
        }
      }
    } while (cursor !== "0");

    return { keys, jobs };
  }

  /**
   * wireVersion 4 → 5 migration: split every `taskora:*:wait` ZSET
   * into a LIST (priority=0, FIFO by ts) plus a matching
   * `taskora:*:prioritized` ZSET (priority>0, score preserved).
   * Atomic per-key via Lua and idempotent — already-migrated keys
   * (LIST or missing) are no-ops. See `scripts.MIGRATE_WAIT_V4_TO_V5`.
   *
   * Hard upgrade: wireVersion 4 workers cannot share a backend with
   * wireVersion 5 workers (LIST vs ZSET WRONGTYPE at runtime). Drain
   * queues or flush keyspace before rolling workers.
   *
   * @internal — exposed for tests; production code goes through handshake().
   */
  async migrateWaitV4ToV5(): Promise<{ keys: number; jobs: number }> {
    const pattern = this.prefix ? `taskora:${this.prefix}:{*}:wait` : "taskora:{*}:wait";
    let cursor = "0";
    let keys = 0;
    let jobs = 0;

    do {
      const result = (await this.driver.command("scan", [
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        "100",
      ])) as [string, string[]];
      cursor = result[0];
      const waitKeys = result[1] ?? [];

      for (const waitKey of waitKeys) {
        const prioritizedKey = `${waitKey.slice(0, -"wait".length)}prioritized`;
        const jobPrefix = waitKey.slice(0, -"wait".length);
        const migrated = (await this.eval(
          "migrateWaitV4ToV5",
          2,
          waitKey,
          prioritizedKey,
          jobPrefix,
        )) as number;
        if (migrated > 0) {
          keys += 1;
          jobs += migrated;
        }
      }
    } while (cursor !== "0");

    return { keys, jobs };
  }

  /**
   * Block until the migration lock is absent OR targets a wire version
   * strictly older than ours (in which case we can continue — we already
   * understand the format the migrator is producing).
   *
   * Polls `taskora:<prefix>:migration:lock` at a fixed interval. Returns
   * immediately if no lock is set (the common case). If a lock IS set,
   * parses the JSON payload and respects its `targetWireVersion`:
   *
   *   - `ourWireVersion <= payload.targetWireVersion` → halt (keep
   *     polling until the lock clears or the deadline expires)
   *   - `ourWireVersion > payload.targetWireVersion`  → proceed (the
   *     migrator is only touching formats older than ours)
   *
   * If the payload is malformed (missing fields, bad JSON), we treat
   * the lock as "halts everyone" to fail safe. If the deadline expires
   * we throw with a clear operator-facing message pointing at the key.
   *
   * Every in-place taskora migration (starting with v1 → v2) sets this
   * lock before touching shared keyspace and clears it after. See
   * `buildMigrationKeys` in keys.ts for the full contract.
   *
   * @param ourWireVersion — the caller's own `WIRE_VERSION`
   * @internal — tests may inject shorter timing via `_migrationPoll`.
   */
  private async awaitMigrationLock(ourWireVersion: number): Promise<void> {
    const { migrationLock } = buildMigrationKeys(this.prefix);
    const maxWaitMs = this._migrationPoll?.maxWaitMs ?? 30_000;
    const intervalMs = this._migrationPoll?.intervalMs ?? 500;

    const deadline = Date.now() + maxWaitMs;
    let first = true;
    while (Date.now() < deadline) {
      const raw = (await this.driver.command("get", [migrationLock])) as string | null;
      if (raw === null) return; // no lock

      // Parse and respect targetWireVersion. Malformed payload → halt
      // (fail safe: assume the migrator wants everyone out).
      let targetVersion = Number.POSITIVE_INFINITY;
      try {
        const parsed = JSON.parse(raw) as Partial<MigrationLockPayload>;
        if (typeof parsed.targetWireVersion === "number") {
          targetVersion = parsed.targetWireVersion;
        }
      } catch {
        // fallthrough — targetVersion stays +Infinity, we halt.
      }

      if (ourWireVersion > targetVersion) return; // we are past the migration

      if (first) {
        // biome-ignore lint/suspicious/noConsole: operator-visible coordination signal
        console.log(
          `[taskora] migration in progress (targetWireVersion=${targetVersion}), waiting for \`${migrationLock}\` to clear…`,
        );
        first = false;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(
      `taskora: migration lock \`${migrationLock}\` still set after ${maxWaitMs}ms. A previous migration run may have crashed before clearing it. Inspect with \`GET ${migrationLock}\` and delete it manually if the migrator is no longer running.`,
    );
  }

  /** @internal — test hook for awaitMigrationLock pacing. */
  _migrationPoll?: { maxWaitMs?: number; intervalMs?: number };

  async enqueue(
    task: string,
    jobId: string,
    data: string,
    options: {
      _v: number;
      maxAttempts?: number;
      expireAt?: number;
      concurrencyKey?: string;
      concurrencyLimit?: number;
      ts?: number;
    } & Taskora.JobOptions,
  ): Promise<void> {
    const keys = buildKeys(task, this.prefix);
    const now = String(options.ts ?? Date.now());
    const maxAttempts = String(options.maxAttempts ?? 1);
    const expireAt = String(options.expireAt ?? 0);
    const concurrencyKey = options.concurrencyKey ?? "";
    const concurrencyLimit = String(options.concurrencyLimit ?? 0);

    if (options.delay && options.delay > 0) {
      await this.eval(
        "enqueueDelayed",
        3,
        keys.delayed,
        keys.events,
        keys.marker,
        keys.jobPrefix,
        jobId,
        data,
        now,
        String(options._v),
        String(options.delay),
        String(options.priority ?? 0),
        maxAttempts,
        expireAt,
        concurrencyKey,
        concurrencyLimit,
      );
      return;
    }

    await this.eval(
      "enqueue",
      4,
      keys.wait,
      keys.events,
      keys.marker,
      keys.prioritized,
      keys.jobPrefix,
      jobId,
      data,
      now,
      String(options._v),
      String(options.priority ?? 0),
      maxAttempts,
      expireAt,
      concurrencyKey,
      concurrencyLimit,
      (options as { _wf?: string })._wf ?? "",
      String((options as { _wfNode?: number })._wfNode ?? ""),
    );
  }

  async enqueueBulk(
    task: string,
    jobs: Array<{
      jobId: string;
      data: string;
      options: {
        _v: number;
        maxAttempts?: number;
        expireAt?: number;
        concurrencyKey?: string;
        concurrencyLimit?: number;
        _wf?: string;
        _wfNode?: number;
      } & Taskora.JobOptions;
    }>,
  ): Promise<void> {
    if (jobs.length === 0) return;

    const keys = buildKeys(task, this.prefix);
    const args: (string | number)[] = [keys.jobPrefix, String(jobs.length)];

    for (const job of jobs) {
      const now = String(job.options.ts ?? Date.now());
      args.push(
        job.jobId,
        job.data,
        now,
        String(job.options._v),
        String(job.options.priority ?? 0),
        String(job.options.maxAttempts ?? 1),
        String(job.options.expireAt ?? 0),
        job.options.concurrencyKey ?? "",
        String(job.options.concurrencyLimit ?? 0),
        String(job.options.delay ?? 0),
        (job.options as { _wf?: string })._wf ?? "",
        String((job.options as { _wfNode?: number })._wfNode ?? ""),
      );
    }

    await this.eval(
      "enqueueBulk",
      5,
      keys.wait,
      keys.delayed,
      keys.events,
      keys.marker,
      keys.prioritized,
      ...args,
    );
  }

  async debounceEnqueue(
    task: string,
    jobId: string,
    data: string,
    options: {
      _v: number;
      maxAttempts?: number;
      priority?: number;
      expireAt?: number;
      concurrencyKey?: string;
      concurrencyLimit?: number;
    },
    debounceKey: string,
    delayMs: number,
  ): Promise<void> {
    const keys = buildKeys(task, this.prefix);
    const base = this.prefix ? `taskora:${this.prefix}:{${task}}` : `taskora:{${task}}`;
    const fullDebounceKey = `${base}:debounce:${debounceKey}`;

    await this.eval(
      "debounce",
      3,
      keys.delayed,
      keys.events,
      keys.marker,
      keys.jobPrefix,
      jobId,
      data,
      String(Date.now()),
      String(options._v),
      String(delayMs),
      String(options.priority ?? 0),
      String(options.maxAttempts ?? 1),
      fullDebounceKey,
      String(options.expireAt ?? 0),
      options.concurrencyKey ?? "",
      String(options.concurrencyLimit ?? 0),
    );
  }

  async throttleEnqueue(
    task: string,
    jobId: string,
    data: string,
    options: {
      _v: number;
      maxAttempts?: number;
      delay?: number;
      priority?: number;
      expireAt?: number;
      concurrencyKey?: string;
      concurrencyLimit?: number;
    },
    throttleKey: string,
    max: number,
    windowMs: number,
  ): Promise<boolean> {
    const keys = buildKeys(task, this.prefix);
    const base = this.prefix ? `taskora:${this.prefix}:{${task}}` : `taskora:{${task}}`;
    const fullThrottleKey = `${base}:throttle:${throttleKey}`;

    const result = await this.eval(
      "throttleEnqueue",
      5,
      keys.wait,
      keys.delayed,
      keys.events,
      keys.marker,
      keys.prioritized,
      keys.jobPrefix,
      jobId,
      data,
      String(Date.now()),
      String(options._v),
      String(options.priority ?? 0),
      String(options.maxAttempts ?? 1),
      fullThrottleKey,
      String(max),
      String(windowMs),
      String(options.delay ?? 0),
      String(options.expireAt ?? 0),
      options.concurrencyKey ?? "",
      String(options.concurrencyLimit ?? 0),
    );
    return result === 1;
  }

  async deduplicateEnqueue(
    task: string,
    jobId: string,
    data: string,
    options: {
      _v: number;
      maxAttempts?: number;
      delay?: number;
      priority?: number;
      expireAt?: number;
      concurrencyKey?: string;
      concurrencyLimit?: number;
    },
    dedupKey: string,
    states: string[],
  ): Promise<{ created: true } | { created: false; existingId: string }> {
    const keys = buildKeys(task, this.prefix);
    const base = this.prefix ? `taskora:${this.prefix}:{${task}}` : `taskora:{${task}}`;
    const fullDedupKey = `${base}:dedup:${dedupKey}`;

    const result = (await this.eval(
      "deduplicateEnqueue",
      5,
      keys.wait,
      keys.delayed,
      keys.events,
      keys.marker,
      keys.prioritized,
      keys.jobPrefix,
      jobId,
      data,
      String(Date.now()),
      String(options._v),
      String(options.priority ?? 0),
      String(options.maxAttempts ?? 1),
      fullDedupKey,
      String(options.delay ?? 0),
      String(options.expireAt ?? 0),
      options.concurrencyKey ?? "",
      String(options.concurrencyLimit ?? 0),
      ...states,
    )) as [number, string?];

    if (result[0] === 0) {
      return { created: false, existingId: result[1] as string };
    }
    return { created: true };
  }

  async collectPush(
    task: string,
    jobId: string,
    item: string,
    options: {
      _v: number;
      maxAttempts?: number;
      collectKey: string;
      delayMs: number;
      maxSize: number;
      maxWaitMs: number;
    },
  ): Promise<{ flushed: boolean; count: number }> {
    const keys = buildKeys(task, this.prefix);

    const result = (await this.eval(
      "collectPush",
      4,
      keys.delayed,
      keys.events,
      keys.marker,
      keys.wait,
      keys.jobPrefix,
      jobId,
      item,
      String(Date.now()),
      String(options._v),
      String(options.delayMs),
      String(options.maxSize),
      String(options.maxWaitMs),
      options.collectKey,
      String(options.maxAttempts ?? 1),
    )) as [number, number];

    return { flushed: result[0] === 1, count: result[1] };
  }

  async peekCollect(task: string, collectKey: string): Promise<string[]> {
    // Non-destructive read of the accumulator list. LRANGE is atomic, so the
    // caller gets a coherent snapshot even if `collectPush` / `moveToActive`
    // is concurrently mutating the buffer. Collect buffer keys share the
    // task's `{hash tag}` via `jobPrefix`, so this is safe under Cluster.
    const keys = buildKeys(task, this.prefix);
    const itemsKey = `${keys.jobPrefix}collect:${collectKey}:items`;
    const result = (await this.driver.command("LRANGE", [itemsKey, "0", "-1"])) as string[];
    return result ?? [];
  }

  async inspectCollect(
    task: string,
    collectKey: string,
  ): Promise<Taskora.CollectBufferInfo | null> {
    // Single HGETALL — cheaper than LRANGE when the caller only needs stats.
    // `count`/`firstAt`/`lastAt` are maintained in lockstep with RPUSH inside
    // the COLLECT_PUSH Lua script, so they reflect the same atomic push as
    // the items list. Empty hash means "no active buffer" (never created or
    // already drained by moveToActive/maxSize flush).
    //
    // Driver-shape normalization: Bun driver returns a `Record<string, string>`
    // for HGETALL, but `ioredis.call("HGETALL", ...)` returns the raw RESP2
    // flat array `[k, v, k, v, ...]`. We normalize here rather than in the
    // ioredis driver to keep that change scoped to this feature — the rest
    // of the backend uses Lua scripts or `command()` for list/string ops
    // where the shapes already match.
    const keys = buildKeys(task, this.prefix);
    const metaKey = `${keys.jobPrefix}collect:${collectKey}:meta`;
    const raw = await this.driver.command("HGETALL", [metaKey]);
    const meta = toHashRecord(raw);
    if (!meta || !meta.count) return null;
    const count = Number(meta.count);
    if (!Number.isFinite(count) || count <= 0) return null;
    return {
      count,
      oldestAt: Number(meta.firstAt),
      newestAt: Number(meta.lastAt),
    };
  }

  async dequeue(
    task: string,
    lockTtl: number,
    token: string,
    options?: Taskora.DequeueOptions,
  ): Promise<Taskora.DequeueResult | null> {
    const keys = buildKeys(task, this.prefix);

    const result = await this.eval(
      "moveToActive",
      7,
      keys.wait,
      keys.active,
      keys.delayed,
      keys.events,
      keys.marker,
      keys.expired,
      keys.prioritized,
      keys.jobPrefix,
      String(lockTtl),
      token,
      String(Date.now()),
      options?.onExpire ?? "fail",
      options?.singleton ? "1" : "0",
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

  async blockingDequeue(
    task: string,
    lockTtl: number,
    token: string,
    timeoutMs: number,
    options?: Taskora.DequeueOptions,
  ): Promise<Taskora.DequeueResult | null> {
    const keys = buildKeys(task, this.prefix);

    // Fast path: try non-blocking moveToActive first
    const quick = await this.dequeue(task, lockTtl, token, options);
    if (quick) return quick;

    const blockClient = await this.getBlockingClient(task);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const remaining = Math.max(0, deadline - Date.now());
      if (remaining <= 0) return null;

      const blockSec = Math.min(remaining, 2000) / 1000;
      let popped: [string, string, string] | null = null;

      try {
        popped = await blockClient.blockingZPopMin(keys.marker, blockSec);
      } catch {
        return null; // connection interrupted (shutdown)
      }

      if (popped) {
        const score = Number(popped[2]);
        const now = Date.now();

        if (score > now) {
          // Delayed marker — wait until due or new marker
          const waitMs = Math.min(score - now, Math.max(0, deadline - now));
          if (waitMs > 0) {
            try {
              await blockClient.blockingZPopMin(keys.marker, waitMs / 1000);
            } catch {
              return null;
            }
          }
        }
      }

      // Try moveToActive (promotes delayed + dequeues)
      const result = await this.dequeue(task, lockTtl, token, options);
      if (result) return result;
    }

    return null;
  }

  private async getBlockingClient(task: string): Promise<RedisDriver> {
    let client = this.blockingClients.get(task);
    if (!client) {
      client = await this.driver.duplicate();
      this.blockingClients.set(task, client);
    }
    return client;
  }

  async ack(task: string, jobId: string, token: string, result: string): Promise<void> {
    const keys = buildKeys(task, this.prefix);
    await this.eval(
      "ack",
      4,
      keys.active,
      keys.completed,
      keys.events,
      keys.marker,
      keys.jobPrefix,
      jobId,
      token,
      result,
      String(Date.now()),
    );
    // Throughput counter — outside Lua to avoid hash tag issues
    this.incrMetric(task, "completed");
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
      5,
      keys.active,
      keys.failed,
      keys.events,
      keys.delayed,
      keys.marker,
      keys.jobPrefix,
      jobId,
      token,
      error,
      String(Date.now()),
      String(retry ? retry.delay : -1),
    );
    // Only count permanent failures, not retries
    if (!retry) this.incrMetric(task, "failed");
  }

  async ackAndDequeue(
    task: string,
    jobId: string,
    token: string,
    result: string,
    newToken: string,
    newLockTtl: number,
    options?: Taskora.DequeueOptions,
  ): Promise<Taskora.AckAndDequeueResult> {
    const keys = buildKeys(task, this.prefix);
    const raw = (await this.eval(
      "ackAndMoveToActive",
      8,
      keys.wait,
      keys.active,
      keys.delayed,
      keys.events,
      keys.marker,
      keys.expired,
      keys.completed,
      keys.prioritized,
      keys.jobPrefix,
      jobId,
      token,
      result,
      String(Date.now()),
      String(newLockTtl),
      newToken,
      options?.onExpire ?? "fail",
      options?.singleton ? "1" : "0",
    )) as [string, string, string, string, string, string, string];

    return this.parseAckAndDequeueReply(raw);
  }

  async failAndDequeue(
    task: string,
    jobId: string,
    token: string,
    error: string,
    retry: { delay: number } | undefined,
    newToken: string,
    newLockTtl: number,
    options?: Taskora.DequeueOptions,
  ): Promise<Taskora.AckAndDequeueResult> {
    const keys = buildKeys(task, this.prefix);
    const raw = (await this.eval(
      "failAndMoveToActive",
      8,
      keys.wait,
      keys.active,
      keys.delayed,
      keys.events,
      keys.marker,
      keys.expired,
      keys.failed,
      keys.prioritized,
      keys.jobPrefix,
      jobId,
      token,
      error,
      String(Date.now()),
      String(retry ? retry.delay : -1),
      String(newLockTtl),
      newToken,
      options?.onExpire ?? "fail",
      options?.singleton ? "1" : "0",
    )) as [string, string, string, string, string, string, string];

    return this.parseAckAndDequeueReply(raw);
  }

  // Parser for the 7-element reply shape emitted by ACK_AND_MOVE_TO_ACTIVE
  // and FAIL_AND_MOVE_TO_ACTIVE. Empty strings are sentinels for "no
  // value" in both the acked-workflow group (first 2) and the next-job
  // group (last 5).
  private parseAckAndDequeueReply(
    raw: [string, string, string, string, string, string, string],
  ): Taskora.AckAndDequeueResult {
    const [wf, wfNode, id, data, _v, attempt, ts] = raw;
    const ackedWorkflow =
      wf && wf !== ""
        ? { workflowId: wf, nodeIndex: Number(wfNode || "0") }
        : null;
    const next =
      id && id !== ""
        ? {
            id,
            data,
            _v: Number(_v),
            attempt: Number(attempt),
            timestamp: Number(ts),
          }
        : null;
    return { next, ackedWorkflow };
  }

  private incrMetric(task: string, type: string): void {
    // Metric keys share the task's {hash tag} via `jobPrefix` so the
    // fused ACK_AND_MOVE_TO_ACTIVE / FAIL_AND_MOVE_TO_ACTIVE scripts can
    // INCR them inside Lua. This fallback path only runs when the worker
    // takes the plain ack()/fail() branch (shutdown or legacy adapter).
    //
    // Fire-and-forget — failures are non-critical (metrics are best-effort).
    // INCR and EXPIRE ride the same pipeline so EXPIRE cannot get dropped
    // on a connection hiccup (a prior implementation leaked TTL-less metric
    // keys by chaining .then() and letting EXPIRE fall off). Pipeline makes
    // both commands one round trip — either both succeed or both fail.
    const keys = buildKeys(task, this.prefix);
    const bucket = Math.floor(Date.now() / 60000) * 60000;
    const key = `${keys.jobPrefix}metrics:${type}:${bucket}`;
    this.driver
      .pipeline()
      .add("incr", [key])
      .add("expire", [key, 86400])
      .exec()
      .catch(() => {});
  }

  async nack(task: string, jobId: string, token: string): Promise<void> {
    const keys = buildKeys(task, this.prefix);
    await this.eval(
      "nack",
      5,
      keys.active,
      keys.wait,
      keys.events,
      keys.marker,
      keys.prioritized,
      keys.jobPrefix,
      jobId,
      token,
    );
  }

  async setProgress(task: string, jobId: string, value: string): Promise<void> {
    const keys = buildKeys(task, this.prefix);
    await this.driver.command("hset", [`${keys.jobPrefix}${jobId}`, "progress", value]);
    await this.driver.command("xadd", [
      keys.events,
      "MAXLEN",
      "~",
      "10000",
      "*",
      "event",
      "progress",
      "jobId",
      jobId,
      "value",
      value,
    ]);
  }

  async addLog(task: string, jobId: string, entry: string): Promise<void> {
    const keys = buildKeys(task, this.prefix);
    const logKey = `${keys.jobPrefix}${jobId}:logs`;
    // RPUSH + LTRIM in one round trip. LTRIM is O(1) while the list is under
    // the cap; once exceeded it trims from the head so the newest entries win.
    await this.driver
      .pipeline()
      .add("rpush", [logKey, entry])
      .add("ltrim", [logKey, -MAX_LOGS_PER_JOB, -1])
      .exec();
  }

  async getState(task: string, jobId: string): Promise<Taskora.JobState | null> {
    const keys = buildKeys(task, this.prefix);
    const state = (await this.driver.command("hget", [`${keys.jobPrefix}${jobId}`, "state"])) as
      | string
      | null;
    return (state as Taskora.JobState) ?? null;
  }

  async getResult(task: string, jobId: string): Promise<string | null> {
    const keys = buildKeys(task, this.prefix);
    return (await this.driver.command("get", [`${keys.jobPrefix}${jobId}:result`])) as
      | string
      | null;
  }

  async getError(task: string, jobId: string): Promise<string | null> {
    const keys = buildKeys(task, this.prefix);
    return (await this.driver.command("hget", [`${keys.jobPrefix}${jobId}`, "error"])) as
      | string
      | null;
  }

  async getProgress(task: string, jobId: string): Promise<string | null> {
    const keys = buildKeys(task, this.prefix);
    return (await this.driver.command("hget", [`${keys.jobPrefix}${jobId}`, "progress"])) as
      | string
      | null;
  }

  async getLogs(task: string, jobId: string): Promise<string[]> {
    const keys = buildKeys(task, this.prefix);
    return (await this.driver.command("lrange", [
      `${keys.jobPrefix}${jobId}:logs`,
      0,
      -1,
    ])) as string[];
  }

  async subscribe(
    tasks: string[],
    handler: (event: Taskora.StreamEvent) => void,
  ): Promise<() => Promise<void>> {
    const subDriver = await this.driver.duplicate();

    const reader = new EventReader(subDriver, this.prefix);
    await reader.start(tasks, handler);

    return async () => {
      await reader.stop();
      // Force-disconnect: the reader may be mid-XREAD-BLOCK, and a graceful
      // close() would wait for it to time out.
      try {
        await subDriver.disconnect();
      } catch {
        // Already disconnected by reader.stop()
      }
    };
  }

  async awaitJob(
    task: string,
    jobId: string,
    timeoutMs?: number,
  ): Promise<Taskora.AwaitJobResult | null> {
    if (!this.jobWaiter) {
      this.jobWaiter = new JobWaiter(this.driver, this.prefix);
    }
    return this.jobWaiter.wait(task, jobId, timeoutMs);
  }

  async stalledCheck(
    task: string,
    maxStalledCount: number,
  ): Promise<{ recovered: string[]; failed: string[] }> {
    const keys = buildKeys(task, this.prefix);
    const result = (await this.eval(
      "stalledCheck",
      8,
      keys.stalled,
      keys.active,
      keys.wait,
      keys.failed,
      keys.events,
      keys.marker,
      keys.cancelled,
      keys.prioritized,
      keys.jobPrefix,
      String(maxStalledCount),
      String(Date.now()),
    )) as (string | number)[];

    const recovered: string[] = [];
    const failed: string[] = [];

    let idx = 0;
    const recoveredCount = Number(result[idx++]);
    for (let i = 0; i < recoveredCount; i++) {
      recovered.push(String(result[idx++]));
    }
    const failedCount = Number(result[idx++]);
    for (let i = 0; i < failedCount; i++) {
      failed.push(String(result[idx++]));
    }

    return { recovered, failed };
  }

  async getVersionDistribution(task: string): Promise<{
    waiting: Record<number, number>;
    active: Record<number, number>;
    delayed: Record<number, number>;
  }> {
    const keys = buildKeys(task, this.prefix);
    const result = (await this.eval(
      "versionDistribution",
      4,
      keys.wait,
      keys.active,
      keys.delayed,
      keys.prioritized,
      keys.jobPrefix,
    )) as string[];

    const distribution: {
      waiting: Record<number, number>;
      active: Record<number, number>;
      delayed: Record<number, number>;
    } = { waiting: {}, active: {}, delayed: {} };

    let i = 0;
    while (i < result.length) {
      const section = result[i++] as "waiting" | "active" | "delayed";
      const bucket = distribution[section];
      while (i < result.length && result[i] !== "END") {
        const version = Number(result[i++]);
        const count = Number(result[i++]);
        bucket[version] = count;
      }
      i++; // skip "END"
    }

    return distribution;
  }

  // ── Inspector ──────────────────────────────────────────────────────

  private static readonly DETAIL_FIELDS = [
    "ts",
    "_v",
    "attempt",
    "state",
    "processedOn",
    "finishedOn",
    "error",
    "progress",
  ] as const;

  private static readonly STATE_MODE: Record<
    string,
    {
      key:
        | "wait"
        | "active"
        | "delayed"
        | "completed"
        | "failed"
        | "expired"
        | "cancelled"
        | "prioritized";
      mode: string;
    }
  > = {
    // Wait queue is split since wireVersion 5: non-priority LIST +
    // prioritized ZSET. `listJobDetails` for 'waiting' queries both
    // and concatenates (prioritized first, then LIST FIFO order).
    active: { key: "active", mode: "lrange" },
    delayed: { key: "delayed", mode: "zrange" },
    completed: { key: "completed", mode: "zrevrange" },
    failed: { key: "failed", mode: "zrevrange" },
    expired: { key: "expired", mode: "zrevrange" },
    cancelled: { key: "cancelled", mode: "zrevrange" },
  };

  async listJobDetails(
    task: string,
    state: "waiting" | "active" | "delayed" | "completed" | "failed" | "expired" | "cancelled",
    offset: number,
    limit: number,
  ): Promise<Array<{ id: string; details: Taskora.RawJobDetails }>> {
    const keys = buildKeys(task, this.prefix);

    // Waiting is the only state that spans two Redis structures. We
    // read prioritized ZSET first (priority DESC, ts ASC) and then
    // the wait LIST (FIFO: RPOP tail first → LRANGE with a trailing
    // offset). Pagination walks across the boundary so the caller
    // sees one continuous window.
    if (state === "waiting") {
      const prioCount = (await this.driver.command("zcard", [keys.prioritized])) as number;
      const listCount = (await this.driver.command("llen", [keys.wait])) as number;
      const total = prioCount + listCount;
      if (offset >= total) return [];

      const results: Array<Array<string | null>> = [];
      let remaining = limit;

      if (offset < prioCount) {
        const take = Math.min(remaining, prioCount - offset);
        const part = (await this.eval(
          "listJobDetails",
          1,
          keys.prioritized,
          keys.jobPrefix,
          String(offset),
          String(take),
          "zrange",
        )) as Array<Array<string | null>>;
        results.push(...(part ?? []));
        remaining -= take;
      }

      if (remaining > 0) {
        const listOffset = Math.max(0, offset - prioCount);
        const part = (await this.eval(
          "listJobDetails",
          1,
          keys.wait,
          keys.jobPrefix,
          String(listOffset),
          String(remaining),
          "wait_list",
        )) as Array<Array<string | null>>;
        results.push(...(part ?? []));
      }

      return this.parseListJobDetails(results);
    }

    const { key, mode } = RedisBackend.STATE_MODE[state];

    const raw = (await this.eval(
      "listJobDetails",
      1,
      keys[key],
      keys.jobPrefix,
      String(offset),
      String(limit),
      mode,
    )) as Array<Array<string | null>>;

    if (!raw || raw.length === 0) return [];
    return this.parseListJobDetails(raw);
  }

  private parseListJobDetails(
    raw: Array<Array<string | null>>,
  ): Array<{ id: string; details: Taskora.RawJobDetails }> {
    // Parse Lua response: each entry = [id, ts, _v, attempt, state,
    //   processedOn, finishedOn, error, progress, data, result, numLogs, ...logs]
    const FIELDS = RedisBackend.DETAIL_FIELDS;
    return raw.map((entry) => {
      const id = entry[0] as string;
      const fields: Record<string, string> = {};
      for (let i = 0; i < FIELDS.length; i++) {
        const val = entry[1 + i];
        if (val) fields[FIELDS[i]] = val;
      }
      const numLogs = Number(entry[11] ?? 0);
      const logs = entry.slice(12, 12 + numLogs) as string[];

      return {
        id,
        details: {
          fields,
          data: entry[9] || null,
          result: entry[10] || null,
          logs,
        },
      };
    });
  }

  async getJobDetails(task: string, jobId: string): Promise<Taskora.RawJobDetails | null> {
    const keys = buildKeys(task, this.prefix);
    const jobKey = `${keys.jobPrefix}${jobId}`;

    const results = await this.driver
      .pipeline()
      .add("hgetall", [jobKey])
      .add("get", [`${jobKey}:data`])
      .add("get", [`${jobKey}:result`])
      .add("lrange", [`${jobKey}:logs`, 0, -1])
      .exec();
    const fields = results[0][1] as Record<string, string>;

    if (!fields || Object.keys(fields).length === 0) return null;

    return {
      fields,
      data: results[1][1] as string | null,
      result: results[2][1] as string | null,
      logs: results[3][1] as string[],
    };
  }

  async getQueueStats(task: string): Promise<Taskora.QueueStats> {
    const keys = buildKeys(task, this.prefix);

    const results = await this.driver
      .pipeline()
      .add("llen", [keys.wait])
      .add("zcard", [keys.prioritized])
      .add("llen", [keys.active])
      .add("zcard", [keys.delayed])
      .add("zcard", [keys.completed])
      .add("zcard", [keys.failed])
      .add("zcard", [keys.expired])
      .add("zcard", [keys.cancelled])
      .exec();
    return {
      waiting: (results[0][1] as number) + (results[1][1] as number),
      active: results[2][1] as number,
      delayed: results[3][1] as number,
      completed: results[4][1] as number,
      failed: results[5][1] as number,
      expired: results[6][1] as number,
      cancelled: results[7][1] as number,
    };
  }

  // ── Dead letter queue ─────────────────────────────────────────────

  async retryFromDLQ(task: string, jobId: string): Promise<boolean> {
    const keys = buildKeys(task, this.prefix);
    const result = await this.eval(
      "retryDLQ",
      5,
      keys.failed,
      keys.wait,
      keys.events,
      keys.marker,
      keys.prioritized,
      keys.jobPrefix,
      jobId,
      String(Date.now()),
    );
    return result === 1;
  }

  async retryAllFromDLQ(task: string, limit: number): Promise<number> {
    const keys = buildKeys(task, this.prefix);
    const result = await this.eval(
      "retryAllDLQ",
      5,
      keys.failed,
      keys.wait,
      keys.events,
      keys.marker,
      keys.prioritized,
      keys.jobPrefix,
      String(limit),
      String(Date.now()),
    );
    return result as number;
  }

  async trimDLQ(task: string, before: number, maxItems: number): Promise<number> {
    const keys = buildKeys(task, this.prefix);
    const result = await this.eval(
      "trimDLQ",
      1,
      keys.failed,
      keys.jobPrefix,
      String(before),
      String(maxItems),
    );
    return result as number;
  }

  async trimCompleted(task: string, before: number, maxItems: number): Promise<number> {
    const keys = buildKeys(task, this.prefix);
    const result = await this.eval(
      "trimDLQ",
      1,
      keys.completed,
      keys.jobPrefix,
      String(before),
      String(maxItems),
    );
    return result as number;
  }

  // ── Scheduling ──────────────────────────────────────────────────────

  async addSchedule(name: string, config: string, nextRun: number): Promise<void> {
    const keys = buildScheduleKeys(this.prefix);
    await this.driver
      .pipeline()
      .add("hset", [keys.schedules, name, config])
      .add("zadd", [keys.schedulesNext, String(nextRun), name])
      .exec();
  }

  async removeSchedule(name: string): Promise<void> {
    const keys = buildScheduleKeys(this.prefix);
    await this.driver
      .pipeline()
      .add("hdel", [keys.schedules, name])
      .add("zrem", [keys.schedulesNext, name])
      .exec();
  }

  async getSchedule(
    name: string,
  ): Promise<{ config: string; nextRun: number | null; paused: boolean } | null> {
    const keys = buildScheduleKeys(this.prefix);
    const results = await this.driver
      .pipeline()
      .add("hget", [keys.schedules, name])
      .add("zscore", [keys.schedulesNext, name])
      .exec();
    const config = results[0][1] as string | null;
    const score = results[1][1] as string | null;

    if (!config) return null;

    return {
      config,
      nextRun: score !== null ? Number(score) : null,
      paused: score === null,
    };
  }

  async listSchedules(): Promise<Taskora.ScheduleRecord[]> {
    const keys = buildScheduleKeys(this.prefix);
    const [all, scores] = await Promise.all([
      this.driver.command("hgetall", [keys.schedules]) as Promise<Record<string, string>>,
      this.driver.command("zrange", [keys.schedulesNext, 0, -1, "WITHSCORES"]) as Promise<string[]>,
    ]);

    const scoreMap = new Map<string, number>();
    for (let i = 0; i < scores.length; i += 2) {
      scoreMap.set(scores[i], Number(scores[i + 1]));
    }

    return Object.entries(all).map(([name, config]) => ({
      name,
      config,
      nextRun: scoreMap.get(name) ?? null,
    }));
  }

  async tickScheduler(now: number): Promise<Array<{ name: string; config: string }>> {
    const keys = buildScheduleKeys(this.prefix);
    const result = (await this.eval(
      "tickScheduler",
      2,
      keys.schedulesNext,
      keys.schedules,
      String(now),
    )) as string[];

    const schedules: Array<{ name: string; config: string }> = [];
    for (let i = 0; i < result.length; i += 2) {
      schedules.push({ name: result[i], config: result[i + 1] });
    }
    return schedules;
  }

  async updateScheduleNextRun(name: string, config: string, nextRun: number): Promise<void> {
    const keys = buildScheduleKeys(this.prefix);
    await this.driver
      .pipeline()
      .add("hset", [keys.schedules, name, config])
      .add("zadd", [keys.schedulesNext, String(nextRun), name])
      .exec();
  }

  async pauseSchedule(name: string): Promise<void> {
    const keys = buildScheduleKeys(this.prefix);
    await this.driver.command("zrem", [keys.schedulesNext, name]);
  }

  async resumeSchedule(name: string, nextRun: number): Promise<void> {
    const keys = buildScheduleKeys(this.prefix);
    await this.driver.command("zadd", [keys.schedulesNext, String(nextRun), name]);
  }

  async acquireSchedulerLock(token: string, ttl: number): Promise<boolean> {
    const keys = buildScheduleKeys(this.prefix);
    const result = await this.eval(
      "acquireSchedulerLock",
      1,
      keys.schedulerLock,
      token,
      String(ttl),
    );
    return result === 1;
  }

  async renewSchedulerLock(token: string, ttl: number): Promise<boolean> {
    const keys = buildScheduleKeys(this.prefix);
    const result = await this.eval("renewSchedulerLock", 1, keys.schedulerLock, token, String(ttl));
    return result === 1;
  }

  async extendLock(
    task: string,
    jobId: string,
    token: string,
    ttl: number,
  ): Promise<"extended" | "lost" | "cancelled"> {
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
    if (result === -1) return "cancelled";
    if (result === 1) return "extended";
    return "lost";
  }

  async cancel(
    task: string,
    jobId: string,
    reason?: string,
  ): Promise<"cancelled" | "flagged" | "not_cancellable"> {
    const keys = buildKeys(task, this.prefix);
    const result = await this.eval(
      "cancel",
      7,
      keys.wait,
      keys.delayed,
      keys.cancelled,
      keys.events,
      keys.marker,
      keys.cancelChannel,
      keys.prioritized,
      keys.jobPrefix,
      jobId,
      reason ?? "",
      String(Date.now()),
    );
    if (result === 1) return "cancelled";
    if (result === 2) return "flagged";
    return "not_cancellable";
  }

  async onCancel(task: string, handler: (jobId: string) => void): Promise<() => void> {
    const keys = buildKeys(task, this.prefix);
    const subDriver = await this.driver.duplicate();
    const unsubscribe = await subDriver.subscribe(keys.cancelChannel, (message) => {
      handler(message);
    });
    return () => {
      // Fire-and-forget cleanup — callers don't await this and it's safe to detach.
      // Force-disconnect: in ioredis, once a client enters subscriber mode, `quit()`
      // sometimes hangs; `disconnect(false)` is reliable.
      unsubscribe()
        .then(() => subDriver.disconnect())
        .catch(() => {});
    };
  }

  async finishCancel(task: string, jobId: string, token: string): Promise<void> {
    const keys = buildKeys(task, this.prefix);
    await this.eval(
      "finishCancel",
      4,
      keys.active,
      keys.cancelled,
      keys.events,
      keys.marker,
      keys.jobPrefix,
      jobId,
      token,
      String(Date.now()),
    );
  }

  // ── Workflows (atomic Lua scripts) ──

  private wfKey(workflowId: string): string {
    const base = this.prefix ? `taskora:${this.prefix}` : "taskora";
    return `${base}:wf:{${workflowId}}`;
  }

  async createWorkflow(workflowId: string, graph: string): Promise<void> {
    const parsed = JSON.parse(graph);
    await this.eval(
      "createWorkflow",
      1,
      this.wfKey(workflowId),
      graph,
      String(Date.now()),
      String(parsed.nodes.length),
    );
  }

  async advanceWorkflow(
    workflowId: string,
    nodeIndex: number,
    result: string,
  ): Promise<Taskora.WorkflowAdvanceResult> {
    const raw = (await this.eval(
      "advanceWorkflow",
      1,
      this.wfKey(workflowId),
      String(nodeIndex),
      result,
    )) as string;
    const parsed = JSON.parse(raw);
    // cjson encodes empty Lua tables as {} (object), normalize to []
    if (!Array.isArray(parsed.toDispatch)) parsed.toDispatch = [];
    return parsed;
  }

  async failWorkflow(
    workflowId: string,
    nodeIndex: number,
    error: string,
  ): Promise<Taskora.WorkflowFailResult> {
    const raw = (await this.eval(
      "failWorkflow",
      1,
      this.wfKey(workflowId),
      String(nodeIndex),
      error,
    )) as string;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.activeJobIds)) parsed.activeJobIds = [];
    return parsed;
  }

  async getWorkflowState(workflowId: string): Promise<string | null> {
    const key = this.wfKey(workflowId);
    const [state, result, error] = (await this.driver.command("hmget", [
      key,
      "state",
      "result",
      "error",
    ])) as (string | null)[];
    if (!state) return null;
    return JSON.stringify({ state, result: result ?? undefined, error: error ?? undefined });
  }

  async cancelWorkflow(workflowId: string, reason?: string): Promise<Taskora.WorkflowCancelResult> {
    const raw = (await this.eval(
      "cancelWorkflow",
      1,
      this.wfKey(workflowId),
      reason ?? "",
    )) as string;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.activeJobIds)) parsed.activeJobIds = [];
    return parsed;
  }

  async getWorkflowMeta(
    task: string,
    jobId: string,
  ): Promise<{ workflowId: string; nodeIndex: number } | null> {
    const keys = buildKeys(task, this.prefix);
    const jobKey = keys.jobPrefix + jobId;
    const [wf, wfNode] = (await this.driver.command("hmget", [jobKey, "_wf", "_wfNode"])) as (
      | string
      | null
    )[];
    if (!wf) return null;
    return { workflowId: wf, nodeIndex: Number(wfNode ?? 0) };
  }

  // ── Board / observability ──────────────────────────────────────────

  async cleanJobs(
    task: string,
    state: Taskora.JobState,
    before: number,
    limit: number,
  ): Promise<number> {
    const keys = buildKeys(task, this.prefix);
    const stateMap: Record<string, string> = {
      completed: keys.completed,
      failed: keys.failed,
      expired: keys.expired,
      cancelled: keys.cancelled,
    };
    const setKey = stateMap[state];
    if (!setKey) return 0;

    const result = await this.eval(
      "cleanJobs",
      1,
      setKey,
      keys.jobPrefix,
      String(before),
      String(limit),
    );
    return result as number;
  }

  async getServerInfo(): Promise<{
    version: string;
    usedMemory: string;
    usedMemoryBytes: number;
    peakMemory: string;
    uptime: number;
    connected: boolean;
    dbSize: number;
    connectedClients: number;
  }> {
    const [serverInfo, memInfo, clientInfo, dbSize] = (await Promise.all([
      this.driver.command("info", ["server"]),
      this.driver.command("info", ["memory"]),
      this.driver.command("info", ["clients"]),
      this.driver.command("dbsize", []),
    ])) as [string, string, string, number];

    const match = (text: string, key: string) => {
      const m = text.match(new RegExp(`${key}:(.+)`));
      return m?.[1]?.trim() ?? "";
    };

    return {
      version: match(serverInfo, "redis_version") || "unknown",
      usedMemory: match(memInfo, "used_memory_human") || "0B",
      usedMemoryBytes: Number(match(memInfo, "used_memory")) || 0,
      peakMemory: match(memInfo, "used_memory_peak_human") || "0B",
      uptime: Number(match(serverInfo, "uptime_in_seconds")) || 0,
      connected: this.connected,
      dbSize,
      connectedClients: Number(match(clientInfo, "connected_clients")) || 0,
    };
  }

  async listWorkflows(
    state?: Taskora.WorkflowState,
    offset = 0,
    limit = 20,
  ): Promise<
    Array<{
      id: string;
      state: Taskora.WorkflowState;
      createdAt: number;
      nodeCount: number;
      name: string | null;
      tasks: string[];
    }>
  > {
    const base = this.prefix ? `taskora:${this.prefix}` : "taskora";
    const pattern = `${base}:wf:{*}`;
    const results: Array<{
      id: string;
      state: Taskora.WorkflowState;
      createdAt: number;
      nodeCount: number;
      name: string | null;
      tasks: string[];
    }> = [];

    let cursor = "0";
    const collected: string[] = [];

    do {
      const [next, keys] = (await this.driver.command("scan", [
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        200,
      ])) as [string, string[]];
      cursor = next;
      collected.push(...keys);
    } while (cursor !== "0");

    const pipe = this.driver.pipeline();
    for (const key of collected) {
      pipe.add("hmget", [key, "state", "createdAt", "graph"]);
    }
    const pipeResults = (await pipe.exec()) as [Error | null, (string | null)[]][];

    for (let i = 0; i < collected.length; i++) {
      const [, values] = pipeResults[i];
      const wfState = values[0] as Taskora.WorkflowState | null;
      if (!wfState) continue;
      if (state && wfState !== state) continue;

      const key = collected[i];
      const idMatch = key.match(/wf:\{(.+)\}$/);
      const id = idMatch?.[1] ?? key;

      let nodeCount = 0;
      let name: string | null = null;
      const tasks: string[] = [];
      if (values[2]) {
        try {
          const graph = JSON.parse(values[2]);
          nodeCount = graph.nodes?.length ?? 0;
          name = graph.name ?? null;
          // Collect unique task names in order
          const seen = new Set<string>();
          for (const node of graph.nodes ?? []) {
            if (!seen.has(node.taskName)) {
              seen.add(node.taskName);
              tasks.push(node.taskName);
            }
          }
        } catch {
          // ignore parse errors
        }
      }

      results.push({
        id,
        state: wfState,
        createdAt: Number(values[1] ?? 0),
        nodeCount,
        name,
        tasks,
      });
    }

    results.sort((a, b) => b.createdAt - a.createdAt);
    return results.slice(offset, offset + limit);
  }

  async getWorkflowDetail(workflowId: string): Promise<Taskora.WorkflowDetail | null> {
    const key = this.wfKey(workflowId);
    const raw = (await this.driver.command("hgetall", [key])) as Record<string, string>;
    if (!raw || !raw.state) return null;

    let graph: Taskora.WorkflowDetail["graph"] = { nodes: [], terminal: [] };
    try {
      graph = JSON.parse(raw.graph);
    } catch {
      // ignore
    }

    const nodes: Taskora.WorkflowDetail["nodes"] = [];
    for (let i = 0; i < graph.nodes.length; i++) {
      nodes.push({
        index: i,
        state: raw[`n:${i}:state`] ?? "pending",
        result: raw[`n:${i}:result`] ?? null,
        error: raw[`n:${i}:error`] ?? null,
        jobId: graph.nodes[i].jobId,
      });
    }

    return {
      id: workflowId,
      state: raw.state as Taskora.WorkflowState,
      createdAt: Number(raw.createdAt ?? 0),
      graph,
      nodes,
      result: raw.result ?? null,
      error: raw.error ?? null,
    };
  }

  async getTaskKeyStats(task: string): Promise<{ keyCount: number; memoryBytes: number }> {
    const keys = buildKeys(task, this.prefix);
    const base = this.prefix ? `taskora:${this.prefix}:{${task}}` : `taskora:{${task}}`;
    const pattern = `${base}:*`;

    // Count keys via SCAN
    let keyCount = 0;
    let cursor = "0";
    do {
      const [next, found] = (await this.driver.command("scan", [
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        500,
      ])) as [string, string[]];
      cursor = next;
      keyCount += found.length;
    } while (cursor !== "0");

    // Sum MEMORY USAGE on main structures (cheap — these are metadata keys)
    let memoryBytes = 0;
    const structKeys = [
      keys.wait,
      keys.prioritized,
      keys.active,
      keys.delayed,
      keys.completed,
      keys.failed,
      keys.expired,
      keys.cancelled,
      keys.events,
      keys.stalled,
      keys.marker,
    ];
    const pipe = this.driver.pipeline();
    for (const k of structKeys) {
      pipe.add("memory", ["USAGE", k]);
    }
    const results = (await pipe.exec()) as [Error | null, number | null][];
    for (const [, bytes] of results) {
      if (bytes) memoryBytes += bytes;
    }

    // Sample a few job keys for memory estimate
    const sampleCursor = "0";
    const sampleKeys: string[] = [];
    const [, firstBatch] = (await this.driver.command("scan", [
      sampleCursor,
      "MATCH",
      `${base}:*`,
      "COUNT",
      20,
    ])) as [string, string[]];
    sampleKeys.push(...firstBatch.slice(0, 10));

    if (sampleKeys.length > 0) {
      const samplePipe = this.driver.pipeline();
      for (const k of sampleKeys) {
        samplePipe.add("memory", ["USAGE", k]);
      }
      const sampleResults = (await samplePipe.exec()) as [Error | null, number | null][];
      let sampleTotal = 0;
      let sampleCount = 0;
      for (const [, bytes] of sampleResults) {
        if (bytes) {
          sampleTotal += bytes;
          sampleCount++;
        }
      }
      if (sampleCount > 0) {
        const avgPerKey = sampleTotal / sampleCount;
        memoryBytes += Math.round(avgPerKey * Math.max(0, keyCount - structKeys.length));
      }
    }

    return { keyCount, memoryBytes };
  }

  async getThroughput(
    task: string | null,
    bucketSize: number,
    count: number,
  ): Promise<Array<{ timestamp: number; completed: number; failed: number }>> {
    // Metric key layout: `<jobPrefix>metrics:<type>:<bucket>` where
    // jobPrefix is `taskora:[prefix:]{task}:`. The task name lives inside
    // the `{hash tag}` so the INCR inside ACK_AND_MOVE_TO_ACTIVE is
    // Cluster-safe. That means the cross-task SCAN below has to match
    // `taskora:[prefix:]{<any>}:metrics:*` rather than a flat `metrics:*`
    // prefix.
    const scanBase = this.prefix ? `taskora:${this.prefix}:` : "taskora:";
    const now = Date.now();
    const currentBucket = Math.floor(now / bucketSize) * bucketSize;
    const timestamps: number[] = [];

    for (let i = count - 1; i >= 0; i--) {
      timestamps.push(currentBucket - i * bucketSize);
    }

    const metricKey = (t: string, type: "completed" | "failed", ts: number) =>
      `${buildKeys(t, this.prefix).jobPrefix}metrics:${type}:${ts}`;

    if (task) {
      // Per-task: read directly
      const pipe = this.driver.pipeline();
      for (const ts of timestamps) {
        pipe.add("get", [metricKey(task, "completed", ts)]);
        pipe.add("get", [metricKey(task, "failed", ts)]);
      }
      const results = (await pipe.exec()) as [Error | null, string | null][];
      return timestamps.map((ts, i) => ({
        timestamp: ts,
        completed: Number(results[i * 2][1] ?? 0),
        failed: Number(results[i * 2 + 1][1] ?? 0),
      }));
    }

    // Aggregate across all tasks: SCAN for metric keys to discover task names.
    // Pattern: `<scanBase>{*}:metrics:completed:*` matches any task's
    // completed-bucket keys under the optional prefix.
    const taskNames = new Set<string>();
    let cursor = "0";
    do {
      const [next, keys] = (await this.driver.command("scan", [
        cursor,
        "MATCH",
        `${scanBase}{*}:metrics:completed:*`,
        "COUNT",
        200,
      ])) as [string, string[]];
      cursor = next;
      for (const key of keys) {
        // key format: taskora:[prefix:]{TASK}:metrics:completed:BUCKET
        const match = key.match(/\{([^}]+)\}:metrics:completed:\d+$/);
        if (match) taskNames.add(match[1]);
      }
    } while (cursor !== "0");

    if (taskNames.size === 0) {
      return timestamps.map((ts) => ({ timestamp: ts, completed: 0, failed: 0 }));
    }

    // Pipeline all reads
    const pipe = this.driver.pipeline();
    const tasks = [...taskNames];
    for (const ts of timestamps) {
      for (const t of tasks) {
        pipe.add("get", [metricKey(t, "completed", ts)]);
        pipe.add("get", [metricKey(t, "failed", ts)]);
      }
    }
    const results = (await pipe.exec()) as [Error | null, string | null][];

    let idx = 0;
    return timestamps.map((ts) => {
      let completed = 0;
      let failed = 0;
      for (const _ of tasks) {
        completed += Number(results[idx++][1] ?? 0);
        failed += Number(results[idx++][1] ?? 0);
      }
      return { timestamp: ts, completed, failed };
    });
  }

  private async loadScripts(): Promise<void> {
    for (const [name, source] of Object.entries(SCRIPT_MAP)) {
      const sha = await this.driver.scriptLoad(source);
      this.shas.set(name, sha);
    }
  }

  private async eval(
    scriptName: string,
    numkeys: number,
    ...args: (string | number)[]
  ): Promise<unknown> {
    // Sticky incompatibility: once a foreign migration left the
    // backend on a wire version we can't read, every eval() is fatal.
    // We throw the latched error even for the exempt scripts — even
    // handshake is pointless once the stored meta has moved past us,
    // because our own Lua can't produce correct writes against the
    // new format.
    if (this.migrationIncompatibleError) throw this.migrationIncompatibleError;
    // Migration hot-path gate: if a foreign migrator is mid-run on this
    // keyspace, block every user-facing script invocation until it
    // clears. The migration-internal scripts and handshake itself are
    // exempt — otherwise our own migration path would deadlock.
    if (this.migrationPaused && !MIGRATION_EXEMPT_SCRIPTS.has(scriptName)) {
      await this.waitForMigration();
    }
    const sha = this.shas.get(scriptName);
    if (!sha) {
      throw new Error(`Script "${scriptName}" not loaded — call connect() first`);
    }
    // NOSCRIPT recovery is handled inside the driver.
    return this.driver.evalSha(sha, numkeys, args, SCRIPT_MAP[scriptName]);
  }
}

/**
 * Script names that are exempt from the migration-pause gate. These
 * are the scripts that RUN during a migration — if we gated them the
 * migration itself would deadlock against its own pause flag.
 *
 * Also includes `handshake` so a process whose handshake is trying
 * to acquire the migration lock can still talk to the meta key
 * while it's checking the current state.
 */
const MIGRATION_EXEMPT_SCRIPTS: ReadonlySet<string> = new Set(["handshake", "migrateWaitV1ToV2"]);

/**
 * Normalize an HGETALL reply to `Record<string, string>`.
 *
 * Different `RedisDriver` implementations return different shapes here:
 *   - Bun driver: already normalized to `Record<string, string>` (the driver
 *     does the flat-array conversion internally so that RESP2 and RESP3
 *     replies look the same to call-sites).
 *   - ioredis driver: `client.call("HGETALL", key)` returns the raw RESP2
 *     flat array `[k, v, k, v, ...]`. (`client.hgetall()` would normalize,
 *     but the generic `command()` passthrough does not.)
 *
 * Returns `null` on an empty/missing hash so callers can distinguish
 * "no entry" from "entry with empty values".
 */
function toHashRecord(raw: unknown): Record<string, string> | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null;
    const out: Record<string, string> = {};
    for (let i = 0; i < raw.length; i += 2) {
      out[String(raw[i])] = String(raw[i + 1]);
    }
    return out;
  }
  if (typeof raw === "object") {
    const obj = raw as Record<string, string>;
    return Object.keys(obj).length === 0 ? null : obj;
  }
  return null;
}
