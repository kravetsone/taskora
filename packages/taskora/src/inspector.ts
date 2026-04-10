import type { Task } from "./task.js";
import type { Taskora } from "./types.js";

const DEFAULT_LIMIT = 20;

export class Inspector {
  private readonly adapter: Taskora.Adapter;
  private readonly serializer: Taskora.Serializer;
  private readonly tasks: Map<string, Task<unknown, unknown>>;

  constructor(
    adapter: Taskora.Adapter,
    serializer: Taskora.Serializer,
    tasks: Map<string, Task<unknown, unknown>>,
  ) {
    this.adapter = adapter;
    this.serializer = serializer;
    this.tasks = tasks;
  }

  // ── List queries ──────────────────────────────────────────────────

  async active(options?: Taskora.InspectorListOptions): Promise<Taskora.JobInfo[]> {
    return this.listByState("active", options);
  }

  async waiting(options?: Taskora.InspectorListOptions): Promise<Taskora.JobInfo[]> {
    return this.listByState("waiting", options);
  }

  async delayed(options?: Taskora.InspectorListOptions): Promise<Taskora.JobInfo[]> {
    return this.listByState("delayed", options);
  }

  async failed(options?: Taskora.InspectorListOptions): Promise<Taskora.JobInfo[]> {
    return this.listByState("failed", options);
  }

  async completed(options?: Taskora.InspectorListOptions): Promise<Taskora.JobInfo[]> {
    return this.listByState("completed", options);
  }

  async expired(options?: Taskora.InspectorListOptions): Promise<Taskora.JobInfo[]> {
    return this.listByState("expired", options);
  }

  async cancelled(options?: Taskora.InspectorListOptions): Promise<Taskora.JobInfo[]> {
    return this.listByState("cancelled", options);
  }

  // ── Stats ─────────────────────────────────────────────────────────

  async stats(options?: { task?: string }): Promise<Taskora.QueueStats> {
    const taskNames = options?.task ? [options.task] : [...this.tasks.keys()];
    const results = await Promise.all(taskNames.map((t) => this.adapter.getQueueStats(t)));

    const merged: Taskora.QueueStats = {
      waiting: 0,
      active: 0,
      delayed: 0,
      completed: 0,
      failed: 0,
      expired: 0,
      cancelled: 0,
    };
    for (const s of results) {
      merged.waiting += s.waiting;
      merged.active += s.active;
      merged.delayed += s.delayed;
      merged.completed += s.completed;
      merged.failed += s.failed;
      merged.expired += s.expired;
      merged.cancelled += s.cancelled;
    }
    return merged;
  }

  // ── Find ──────────────────────────────────────────────────────────

  find(jobId: string): Promise<Taskora.JobInfo | null>;
  find<TInput, TOutput>(
    task: Task<TInput, TOutput>,
    jobId: string,
  ): Promise<Taskora.JobInfo<TInput, TOutput> | null>;
  async find(
    taskOrJobId: string | Task<unknown, unknown>,
    maybeJobId?: string,
  ): Promise<Taskora.JobInfo | null> {
    if (typeof taskOrJobId !== "string") {
      // Typed variant: find(task, jobId)
      const task = taskOrJobId;
      const jobId = maybeJobId as string;
      return this.findForTask(task.name, jobId);
    }

    // Untyped variant: find(jobId) — search across all tasks
    const jobId = taskOrJobId;
    const checks = await Promise.all(
      [...this.tasks.keys()].map(async (name) => ({
        name,
        state: await this.adapter.getState(name, jobId),
      })),
    );
    const found = checks.find((c) => c.state !== null);
    if (!found) return null;
    return this.findForTask(found.name, jobId);
  }

  // ── Migrations (existing) ─────────────────────────────────────────

  async migrations(taskName: string): Promise<Taskora.MigrationStatus> {
    const task = this.tasks.get(taskName);
    if (!task) {
      throw new Error(`Task "${taskName}" not found`);
    }

    const dist = await this.adapter.getVersionDistribution(taskName);

    // Merge waiting + active into "queue"
    const queueByVersion: Record<number, number> = {};
    for (const bucket of [dist.waiting, dist.active]) {
      for (const [v, count] of Object.entries(bucket)) {
        const version = Number(v);
        queueByVersion[version] = (queueByVersion[version] ?? 0) + count;
      }
    }

    const delayedByVersion: Record<number, number> = {};
    for (const [v, count] of Object.entries(dist.delayed)) {
      delayedByVersion[Number(v)] = count;
    }

    // Find oldest version across all buckets
    const allVersions = [
      ...Object.keys(queueByVersion).map(Number),
      ...Object.keys(delayedByVersion).map(Number),
    ];
    const queueVersions = Object.keys(queueByVersion).map(Number);
    const delayedVersions = Object.keys(delayedByVersion).map(Number);

    const queueOldest = queueVersions.length > 0 ? Math.min(...queueVersions) : null;
    const delayedOldest = delayedVersions.length > 0 ? Math.min(...delayedVersions) : null;

    // canBumpSince = min version across all jobs (safe to prune migrations below this)
    const canBumpSince = allVersions.length > 0 ? Math.min(...allVersions) : task.version;

    return {
      version: task.version,
      since: task.since,
      migrations: task.migrations.size,
      queue: {
        oldest: queueOldest,
        byVersion: queueByVersion,
      },
      delayed: {
        oldest: delayedOldest,
        byVersion: delayedByVersion,
      },
      canBumpSince,
    };
  }

  // ── Private ───────────────────────────────────────────────────────

  private async listByState(
    state: "waiting" | "active" | "delayed" | "completed" | "failed" | "expired" | "cancelled",
    options?: Taskora.InspectorListOptions,
  ): Promise<Taskora.JobInfo[]> {
    const limit = options?.limit ?? DEFAULT_LIMIT;
    const offset = options?.offset ?? 0;
    const taskNames = options?.task ? [options.task] : [...this.tasks.keys()];

    // Each adapter call does LRANGE + pipeline details in 2 Redis RTTs.
    // Parallelize across tasks.
    const perTask = await Promise.all(
      taskNames.map(async (name) => {
        const entries = await this.adapter.listJobDetails(name, state, offset, limit);
        return entries.map(({ id, details }) => this.buildJobInfo(name, id, details));
      }),
    );

    return perTask.flat();
  }

  private async findForTask(taskName: string, jobId: string): Promise<Taskora.JobInfo | null> {
    const raw = await this.adapter.getJobDetails(taskName, jobId);
    if (!raw) return null;
    return this.buildJobInfo(taskName, jobId, raw);
  }

  private buildJobInfo(
    taskName: string,
    jobId: string,
    raw: Taskora.RawJobDetails,
  ): Taskora.JobInfo {
    const f = raw.fields;
    const state = (f.state ?? "unknown") as Taskora.JobState;
    const timestamp = Number(f.ts ?? 0);
    const processedOn = f.processedOn ? Number(f.processedOn) : undefined;
    const finishedOn = f.finishedOn ? Number(f.finishedOn) : undefined;

    // Build timeline from stored timestamps
    const timeline: Array<{ state: string; at: number }> = [];
    if (timestamp) timeline.push({ state: "waiting", at: timestamp });
    if (processedOn) timeline.push({ state: "active", at: processedOn });
    if (finishedOn) {
      const terminalState =
        state === "completed"
          ? "completed"
          : state === "expired"
            ? "expired"
            : state === "cancelled"
              ? "cancelled"
              : "failed";
      timeline.push({ state: terminalState, at: finishedOn });
    }

    // Parse progress
    let progress: number | Record<string, unknown> | undefined;
    if (f.progress) {
      const num = Number(f.progress);
      if (!Number.isNaN(num) && String(num) === f.progress) {
        progress = num;
      } else {
        try {
          progress = JSON.parse(f.progress);
        } catch {
          progress = undefined;
        }
      }
    }

    // Parse logs
    const logs: Taskora.LogEntry[] = raw.logs.map((entry) => JSON.parse(entry));

    return {
      id: jobId,
      task: taskName,
      state,
      data: raw.data ? this.serializer.deserialize(raw.data) : undefined,
      result: raw.result ? this.serializer.deserialize(raw.result) : undefined,
      error: f.error,
      progress,
      logs,
      attempt: Number(f.attempt ?? 1),
      version: Number(f._v ?? 1),
      timestamp,
      processedOn,
      finishedOn,
      timeline,
    };
  }
}
