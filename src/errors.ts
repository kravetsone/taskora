export class TaskoraError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskoraError";
  }
}

export class ValidationError extends TaskoraError {
  readonly issues: ReadonlyArray<{
    message: string;
    path?: ReadonlyArray<string | number>;
  }>;

  constructor(
    message: string,
    issues: ReadonlyArray<{
      message: string;
      path?: ReadonlyArray<string | number>;
    }>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ValidationError";
    this.issues = issues;
  }
}

export class RetryError extends TaskoraError {
  readonly delay?: number;

  constructor(options?: { message?: string; delay?: number; cause?: unknown }) {
    super(options?.message ?? "Job scheduled for retry", { cause: options?.cause });
    this.name = "RetryError";
    this.delay = options?.delay;
  }
}

export class StalledError extends TaskoraError {
  readonly jobId: string;

  constructor(jobId: string, options?: ErrorOptions) {
    super(`Job ${jobId} stalled`, options);
    this.name = "StalledError";
    this.jobId = jobId;
  }
}

export class JobFailedError extends TaskoraError {
  readonly jobId: string;
  readonly taskName: string;

  constructor(jobId: string, taskName: string, message: string) {
    super(message);
    this.name = "JobFailedError";
    this.jobId = jobId;
    this.taskName = taskName;
  }
}

export class TimeoutError extends TaskoraError {
  readonly jobId: string;
  readonly timeoutMs: number;

  constructor(jobId: string, timeoutMs: number) {
    super(`Job ${jobId} did not complete within ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.jobId = jobId;
    this.timeoutMs = timeoutMs;
  }
}
