import type { Task } from "./task.js";
import type { Taskora } from "./types.js";

export class Inspector {
  private readonly adapter: Taskora.Adapter;
  private readonly tasks: Map<string, Task<unknown, unknown>>;

  constructor(adapter: Taskora.Adapter, tasks: Map<string, Task<unknown, unknown>>) {
    this.adapter = adapter;
    this.tasks = tasks;
  }

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
}
