import { RetryError } from "./errors.js";
import type { Taskora } from "./types.js";

export function createContext(options: {
  id: string;
  attempt: number;
  timestamp: number;
  signal: AbortSignal;
  onHeartbeat: () => void;
  onProgress: (value: string) => void;
  onLog: (entry: string) => void;
}): Taskora.Context {
  function writeLog(
    level: "info" | "warn" | "error",
    message: string,
    meta?: Record<string, unknown>,
  ) {
    const entry: Taskora.LogEntry = { level, message, meta, timestamp: Date.now() };
    options.onLog(JSON.stringify(entry));
  }

  return {
    id: options.id,
    attempt: options.attempt,
    timestamp: options.timestamp,
    signal: options.signal,
    heartbeat: options.onHeartbeat,
    retry(retryOptions) {
      return new RetryError({
        message: retryOptions?.reason,
        delay: retryOptions?.delay,
      });
    },
    progress(value) {
      const serialized = typeof value === "number" ? String(value) : JSON.stringify(value);
      options.onProgress(serialized);
    },
    log: {
      info: (message, meta) => writeLog("info", message, meta),
      warn: (message, meta) => writeLog("warn", message, meta),
      error: (message, meta) => writeLog("error", message, meta),
    },
  };
}
