import { describe, expect, it, vi } from "vitest";
import { computeDelay, shouldRetry } from "../../src/backoff.js";
import type { Taskora } from "../../src/types.js";

const noJitter = (config: Partial<Taskora.RetryConfig>): Taskora.RetryConfig => ({
  attempts: 3,
  jitter: false,
  ...config,
});

describe("computeDelay", () => {
  it("exponential backoff: 1s, 2s, 4s, 8s", () => {
    const config = noJitter({ backoff: "exponential" });
    expect(computeDelay(1, config)).toBe(1000);
    expect(computeDelay(2, config)).toBe(2000);
    expect(computeDelay(3, config)).toBe(4000);
    expect(computeDelay(4, config)).toBe(8000);
  });

  it("exponential is the default strategy", () => {
    const config = noJitter({});
    expect(computeDelay(1, config)).toBe(1000);
    expect(computeDelay(2, config)).toBe(2000);
  });

  it("fixed backoff: always base delay", () => {
    const config = noJitter({ backoff: "fixed" });
    expect(computeDelay(1, config)).toBe(1000);
    expect(computeDelay(2, config)).toBe(1000);
    expect(computeDelay(5, config)).toBe(1000);
  });

  it("linear backoff: delay * attempt", () => {
    const config = noJitter({ backoff: "linear" });
    expect(computeDelay(1, config)).toBe(1000);
    expect(computeDelay(2, config)).toBe(2000);
    expect(computeDelay(3, config)).toBe(3000);
  });

  it("custom backoff function", () => {
    const config = noJitter({ backoff: (attempt) => attempt * 500 });
    expect(computeDelay(1, config)).toBe(500);
    expect(computeDelay(3, config)).toBe(1500);
  });

  it("respects custom base delay", () => {
    const config = noJitter({ backoff: "exponential", delay: 2000 });
    expect(computeDelay(1, config)).toBe(2000);
    expect(computeDelay(2, config)).toBe(4000);
  });

  it("caps at maxDelay", () => {
    const config = noJitter({ backoff: "exponential", maxDelay: 5000 });
    expect(computeDelay(1, config)).toBe(1000);
    expect(computeDelay(2, config)).toBe(2000);
    expect(computeDelay(3, config)).toBe(4000);
    expect(computeDelay(4, config)).toBe(5000); // capped
    expect(computeDelay(5, config)).toBe(5000); // capped
  });

  it("jitter stays within +-25% bounds", () => {
    const config: Taskora.RetryConfig = {
      attempts: 3,
      backoff: "fixed",
      delay: 1000,
      jitter: true,
    };

    for (let i = 0; i < 100; i++) {
      const d = computeDelay(1, config);
      expect(d).toBeGreaterThanOrEqual(750);
      expect(d).toBeLessThanOrEqual(1250);
    }
  });

  it("jitter disabled returns exact delay", () => {
    const config = noJitter({ backoff: "fixed", delay: 1000 });
    expect(computeDelay(1, config)).toBe(1000);
    expect(computeDelay(1, config)).toBe(1000);
  });

  it("never returns negative delay", () => {
    const config = noJitter({ backoff: () => -100 });
    expect(computeDelay(1, config)).toBe(0);
  });
});

describe("shouldRetry", () => {
  class NetworkError extends Error {}
  class AuthError extends Error {}
  class ValidationError extends Error {}

  it("retries when under attempt limit", () => {
    expect(shouldRetry(new Error(), 1, { attempts: 3 })).toBe(true);
    expect(shouldRetry(new Error(), 2, { attempts: 3 })).toBe(true);
  });

  it("does not retry when attempts exhausted", () => {
    expect(shouldRetry(new Error(), 3, { attempts: 3 })).toBe(false);
    expect(shouldRetry(new Error(), 5, { attempts: 3 })).toBe(false);
  });

  it("noRetryOn: matching error skips retry", () => {
    const config: Taskora.RetryConfig = {
      attempts: 5,
      noRetryOn: [AuthError, ValidationError],
    };
    expect(shouldRetry(new AuthError(), 1, config)).toBe(false);
    expect(shouldRetry(new ValidationError(), 1, config)).toBe(false);
    expect(shouldRetry(new NetworkError(), 1, config)).toBe(true);
    expect(shouldRetry(new Error(), 1, config)).toBe(true);
  });

  it("retryOn: only matching errors are retried", () => {
    const config: Taskora.RetryConfig = {
      attempts: 5,
      retryOn: [NetworkError],
    };
    expect(shouldRetry(new NetworkError(), 1, config)).toBe(true);
    expect(shouldRetry(new AuthError(), 1, config)).toBe(false);
    expect(shouldRetry(new Error(), 1, config)).toBe(false);
  });

  it("noRetryOn takes precedence over retryOn", () => {
    const config: Taskora.RetryConfig = {
      attempts: 5,
      retryOn: [NetworkError, AuthError],
      noRetryOn: [AuthError],
    };
    expect(shouldRetry(new NetworkError(), 1, config)).toBe(true);
    expect(shouldRetry(new AuthError(), 1, config)).toBe(false);
  });
});
