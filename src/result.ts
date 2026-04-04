import { JobFailedError, TimeoutError } from "./errors.js";
import type { Taskora } from "./types.js";

const POLL_MIN = 50;
const POLL_MAX = 500;
const POLL_FACTOR = 1.5;

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

    const deadline = timeout != null ? Date.now() + timeout : undefined;
    let delay = POLL_MIN;

    while (true) {
      const state = await this.adapter.getState(this.taskName, this.id);

      if (state === "completed") {
        const raw = await this.adapter.getResult(this.taskName, this.id);
        if (raw == null) throw new JobFailedError(this.id, this.taskName, "Result missing");
        return this.serializer.deserialize(raw) as TOutput;
      }

      if (state === "failed") {
        const errMsg = await this.adapter.getError(this.taskName, this.id);
        throw new JobFailedError(this.id, this.taskName, errMsg ?? `Job ${this.id} failed`);
      }

      if (state === "cancelled") {
        throw new JobFailedError(this.id, this.taskName, "Job was cancelled");
      }

      if (deadline != null && Date.now() + delay >= deadline) {
        throw new TimeoutError(this.id, timeout as number);
      }

      await sleep(delay);
      delay = Math.min(delay * POLL_FACTOR, POLL_MAX);
    }
  }

  async getState(): Promise<Taskora.JobState | null> {
    return this.adapter.getState(this.taskName, this.id);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
