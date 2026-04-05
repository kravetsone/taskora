import { JobFailedError, TimeoutError } from "./errors.js";
import type { Taskora } from "./types.js";

export class ResultHandle<TOutput> {
  readonly id: string;

  private readonly taskName: string;
  private readonly adapter: Taskora.Adapter;
  private readonly serializer: Taskora.Serializer;
  private readonly enqueuePromise: Promise<void>;
  private enqueueError: unknown = undefined;
  private enqueued = false;

  constructor(
    id: string,
    taskName: string,
    adapter: Taskora.Adapter,
    serializer: Taskora.Serializer,
    enqueuePromise: Promise<void>,
  ) {
    this.id = id;
    this.taskName = taskName;
    this.adapter = adapter;
    this.serializer = serializer;
    this.enqueuePromise = enqueuePromise.then(
      () => {
        this.enqueued = true;
      },
      (err) => {
        this.enqueueError = err;
      },
    );
  }

  // biome-ignore lint/suspicious/noThenProperty: ResultHandle is intentionally thenable
  then<TResult1 = string, TResult2 = never>(
    onfulfilled?: ((value: string) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.ensureEnqueued().then(
      () => (onfulfilled ? onfulfilled(this.id) : (this.id as TResult1)),
      onrejected ??
        ((err) => {
          throw err;
        }),
    );
  }

  async ensureEnqueued(): Promise<void> {
    await this.enqueuePromise;
    if (this.enqueueError) {
      throw this.enqueueError;
    }
  }

  get result(): Promise<TOutput> {
    return this.waitFor();
  }

  async waitFor(timeout?: number): Promise<TOutput> {
    await this.ensureEnqueued();

    const result = await this.adapter.awaitJob(this.taskName, this.id, timeout);

    if (!result) {
      throw new TimeoutError(this.id, timeout as number);
    }

    if (result.state === "completed") {
      if (result.result == null) {
        throw new JobFailedError(this.id, this.taskName, "Result missing");
      }
      return this.serializer.deserialize(result.result) as TOutput;
    }

    if (result.state === "failed") {
      throw new JobFailedError(this.id, this.taskName, result.error ?? `Job ${this.id} failed`);
    }

    // cancelled
    throw new JobFailedError(this.id, this.taskName, "Job was cancelled");
  }

  async getState(): Promise<Taskora.JobState | null> {
    return this.adapter.getState(this.taskName, this.id);
  }

  async getProgress(): Promise<number | Record<string, unknown> | null> {
    const raw = await this.adapter.getProgress(this.taskName, this.id);
    if (raw == null) return null;
    const num = Number(raw);
    if (!Number.isNaN(num) && String(num) === raw) return num;
    return JSON.parse(raw);
  }

  async getLogs(): Promise<Taskora.LogEntry[]> {
    const raw = await this.adapter.getLogs(this.taskName, this.id);
    return raw.map((entry) => JSON.parse(entry));
  }
}
