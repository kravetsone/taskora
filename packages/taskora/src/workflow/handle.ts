import { CancelledError, JobFailedError } from "../errors.js";
import type { Taskora } from "../types.js";
import type { WorkflowGraph } from "./graph.js";

export class WorkflowHandle<TOutput> {
  readonly workflowId: string;

  private readonly graph: WorkflowGraph;
  private readonly adapter: Taskora.Adapter;
  private readonly serializer: Taskora.Serializer;
  private readonly dispatchPromise: Promise<void>;
  private dispatchError: unknown = undefined;

  constructor(
    workflowId: string,
    graph: WorkflowGraph,
    adapter: Taskora.Adapter,
    serializer: Taskora.Serializer,
    dispatchPromise: Promise<void>,
  ) {
    this.workflowId = workflowId;
    this.graph = graph;
    this.adapter = adapter;
    this.serializer = serializer;
    this.dispatchPromise = dispatchPromise.catch((err) => {
      this.dispatchError = err;
    });
  }

  // biome-ignore lint/suspicious/noThenProperty: WorkflowHandle is intentionally thenable
  then<TResult1 = string, TResult2 = never>(
    onfulfilled?: ((value: string) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.ensureDispatched().then(
      () => (onfulfilled ? onfulfilled(this.workflowId) : (this.workflowId as unknown as TResult1)),
      onrejected ??
        ((err) => {
          throw err;
        }),
    );
  }

  async ensureDispatched(): Promise<void> {
    await this.dispatchPromise;
    if (this.dispatchError) {
      throw this.dispatchError;
    }
  }

  get result(): Promise<TOutput> {
    return this.waitForResult();
  }

  async cancel(options?: { reason?: string }): Promise<void> {
    await this.ensureDispatched();
    const { activeJobIds } = await this.adapter.cancelWorkflow(this.workflowId, options?.reason);
    const reason = options?.reason ?? "workflow cancelled";
    for (const { task, jobId } of activeJobIds) {
      try {
        await this.adapter.cancel(task, jobId, reason);
      } catch {
        // Job may have already finished
      }
    }
  }

  async getState(): Promise<Taskora.WorkflowState | null> {
    const raw = await this.adapter.getWorkflowState(this.workflowId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed.state as Taskora.WorkflowState;
  }

  // ── Internal ──────────────────────────────────────────────────────

  private async waitForResult(): Promise<TOutput> {
    await this.ensureDispatched();

    const terminals = this.graph.terminal.map((i) => this.graph.nodes[i]);

    if (terminals.length === 1) {
      const node = terminals[0];
      const result = await this.adapter.awaitJob(node.taskName, node.jobId);
      return this.resolveJobResult(node.jobId, node.taskName, result) as TOutput;
    }

    // Multiple terminals (group) — wait for all, return tuple
    const results = await Promise.all(
      terminals.map(async (node) => {
        const result = await this.adapter.awaitJob(node.taskName, node.jobId);
        return this.resolveJobResult(node.jobId, node.taskName, result);
      }),
    );
    return results as unknown as TOutput;
  }

  private resolveJobResult(
    jobId: string,
    taskName: string,
    result: Taskora.AwaitJobResult | null,
  ): unknown {
    if (!result) {
      throw new JobFailedError(jobId, taskName, `Workflow job ${jobId} result unavailable`);
    }
    if (result.state === "completed") {
      if (result.result == null) {
        return undefined;
      }
      return this.serializer.deserialize(result.result);
    }
    if (result.state === "failed") {
      throw new JobFailedError(jobId, taskName, result.error ?? `Job ${jobId} failed`);
    }
    // cancelled
    throw new CancelledError(jobId, result.error);
  }
}
