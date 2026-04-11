import type { TaskContract, Taskora } from "taskora";

/**
 * Metadata key for class-level `@TaskConsumer(contract, options?)`
 * markers. Read by {@link TaskoraExplorer} during
 * `onApplicationBootstrap` to wire DI-managed handlers to the right
 * {@link App.implement} call.
 */
export const TASK_CONSUMER_METADATA = Symbol.for("taskora:task-consumer");

/**
 * Metadata key for method-level `@OnTaskEvent('completed' | ...)` bindings.
 * Stored as an array on the class constructor so all bindings for a
 * consumer can be retrieved in one lookup.
 */
export const ON_TASK_EVENT_METADATA = Symbol.for("taskora:on-task-event");

/**
 * Configuration accepted by `@TaskConsumer(contract, options)`.
 *
 * Mirrors the subset of {@link App.implement} options that make sense
 * at the DI layer — per-task retry, timeout, concurrency, TTL, etc.
 * Middleware, onCancel and migrations land in phase 4 once class-based
 * middleware is in place.
 */
export interface TaskConsumerOptions {
  /**
   * Bind this consumer to a specific named app registered via
   * `TaskoraModule.forRoot({ name })`. Omit for single-app setups.
   */
  app?: string;
  concurrency?: number;
  timeout?: number;
  retry?: Taskora.RetryConfig;
  stall?: Taskora.StallConfig;
  singleton?: boolean;
  concurrencyLimit?: number;
  ttl?: Taskora.TtlConfig;
  version?: number;
  since?: number;
}

export interface TaskConsumerMetadata {
  contract: TaskContract<any, any>;
  options: TaskConsumerOptions;
}

export interface TaskEventBinding {
  event: string;
  method: string | symbol;
}
