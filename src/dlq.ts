import type { Inspector } from "./inspector.js";
import type { Task } from "./task.js";
import type { Taskora } from "./types.js";

const RETRY_BATCH_SIZE = 100;

export class DeadLetterManager {
  private readonly adapter: Taskora.Adapter;
  private readonly tasks: Map<string, Task<unknown, unknown>>;
  private readonly getInspector: () => Inspector;

  constructor(
    adapter: Taskora.Adapter,
    tasks: Map<string, Task<unknown, unknown>>,
    getInspector: () => Inspector,
  ) {
    this.adapter = adapter;
    this.tasks = tasks;
    this.getInspector = getInspector;
  }

  async list(options?: Taskora.InspectorListOptions): Promise<Taskora.JobInfo[]> {
    return this.getInspector().failed(options);
  }

  async retry(jobId: string): Promise<boolean>;
  async retry(task: string, jobId: string): Promise<boolean>;
  async retry(taskOrJobId: string, maybeJobId?: string): Promise<boolean> {
    if (maybeJobId !== undefined) {
      // retry(task, jobId)
      return this.adapter.retryFromDLQ(taskOrJobId, maybeJobId);
    }

    // retry(jobId) — search across tasks
    const jobId = taskOrJobId;
    for (const taskName of this.tasks.keys()) {
      const state = await this.adapter.getState(taskName, jobId);
      if (state === "failed") {
        return this.adapter.retryFromDLQ(taskName, jobId);
      }
    }
    return false;
  }

  async retryAll(options?: { task?: string }): Promise<number> {
    const taskNames = options?.task ? [options.task] : [...this.tasks.keys()];
    let total = 0;

    for (const taskName of taskNames) {
      let retried: number;
      do {
        retried = await this.adapter.retryAllFromDLQ(taskName, RETRY_BATCH_SIZE);
        total += retried;
      } while (retried === RETRY_BATCH_SIZE);
    }

    return total;
  }
}
