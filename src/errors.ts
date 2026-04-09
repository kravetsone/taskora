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

export class ThrottledError extends TaskoraError {
  readonly jobId: string;
  readonly key: string;

  constructor(jobId: string, key: string) {
    super(`Job ${jobId} throttled on key "${key}"`);
    this.name = "ThrottledError";
    this.jobId = jobId;
    this.key = key;
  }
}

export class DuplicateJobError extends TaskoraError {
  readonly jobId: string;
  readonly key: string;
  readonly existingId: string;

  constructor(jobId: string, key: string, existingId: string) {
    super(`Job ${jobId} deduplicated on key "${key}" — existing job ${existingId}`);
    this.name = "DuplicateJobError";
    this.jobId = jobId;
    this.key = key;
    this.existingId = existingId;
  }
}

export class ExpiredError extends TaskoraError {
  readonly jobId: string;

  constructor(jobId: string) {
    super(`Job ${jobId} expired before processing`);
    this.name = "ExpiredError";
    this.jobId = jobId;
  }
}

export class CancelledError extends TaskoraError {
  readonly jobId: string;
  readonly reason?: string;

  constructor(jobId: string, reason?: string) {
    super(reason ? `Job ${jobId} cancelled: ${reason}` : `Job ${jobId} cancelled`);
    this.name = "CancelledError";
    this.jobId = jobId;
    this.reason = reason;
  }
}

/**
 * Thrown by {@link App.ensureConnected} when the wire-format version compiled
 * into this process is incompatible with the meta record the storage backend
 * already has. Stops the process before any worker, scheduler, or dispatch
 * can touch incompatible data.
 *
 * See `src/wire-version.ts` for the full compatibility rule and the policy
 * for bumping `WIRE_VERSION` / `MIN_COMPAT_VERSION`.
 */
export class SchemaVersionMismatchError extends TaskoraError {
  readonly code: "theirs_too_new" | "theirs_too_old" | "invalid_meta";
  readonly ours: {
    wireVersion: number;
    minCompat: number;
    writtenBy: string;
  };
  readonly theirs: {
    wireVersion: number;
    minCompat: number;
    writtenBy: string;
    writtenAt: number;
  };

  constructor(
    code: "theirs_too_new" | "theirs_too_old" | "invalid_meta",
    message: string,
    ours: { wireVersion: number; minCompat: number; writtenBy: string },
    theirs: { wireVersion: number; minCompat: number; writtenBy: string; writtenAt: number },
  ) {
    super(message);
    this.name = "SchemaVersionMismatchError";
    this.code = code;
    this.ours = ours;
    this.theirs = theirs;
  }
}
