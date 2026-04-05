import type { Taskora } from "./types.js";

const DEFAULT_DELAY = 1000;

export function computeDelay(attempt: number, config: Taskora.RetryConfig): number {
  const baseDelay = config.delay ?? DEFAULT_DELAY;
  const strategy = config.backoff ?? "exponential";

  let delay: number;
  if (typeof strategy === "function") {
    delay = strategy(attempt);
  } else if (strategy === "fixed") {
    delay = baseDelay;
  } else if (strategy === "linear") {
    delay = baseDelay * attempt;
  } else {
    // exponential: baseDelay * 2^(attempt-1)
    delay = baseDelay * 2 ** (attempt - 1);
  }

  if (config.maxDelay != null) {
    delay = Math.min(delay, config.maxDelay);
  }

  if (config.jitter !== false) {
    // ±25% jitter
    const factor = 0.75 + Math.random() * 0.5;
    delay = Math.round(delay * factor);
  }

  return Math.max(0, delay);
}

export function shouldRetry(error: unknown, attempt: number, config: Taskora.RetryConfig): boolean {
  if (attempt >= config.attempts) return false;

  if (config.noRetryOn) {
    for (const ErrorClass of config.noRetryOn) {
      if (error instanceof ErrorClass) return false;
    }
  }

  if (config.retryOn) {
    for (const ErrorClass of config.retryOn) {
      if (error instanceof ErrorClass) return true;
    }
    return false;
  }

  return true;
}
