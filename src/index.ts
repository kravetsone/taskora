export type { Taskora } from "./types.js";
export { TaskoraError, ValidationError, RetryError, StalledError } from "./errors.js";

import type { Taskora } from "./types.js";

export interface TaskoraOptions {
  backend: Taskora.Adapter;
  defaults?: {
    retry?: { max?: number; backoff?: "exponential" | "linear" | "fixed" };
    timeout?: number;
  };
}

export function taskora(_options: TaskoraOptions) {
  return {
    task: (_name: string, _handler: unknown) => {
      throw new Error("Not implemented: task registration comes in Phase 1");
    },
    start: async () => {
      throw new Error("Not implemented: worker start comes in Phase 1");
    },
    close: async () => {
      throw new Error("Not implemented: graceful shutdown comes in Phase 1");
    },
  };
}
