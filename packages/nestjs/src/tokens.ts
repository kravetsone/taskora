import type { TaskContract } from "taskora";

export const DEFAULT_APP_NAME = "default";

export function getAppToken(name: string = DEFAULT_APP_NAME): string {
  return `TASKORA_APP:${name}`;
}

export function getOptionsToken(name: string = DEFAULT_APP_NAME): string {
  return `TASKORA_OPTIONS:${name}`;
}

export function getLifecycleToken(name: string = DEFAULT_APP_NAME): string {
  return `TASKORA_LIFECYCLE:${name}`;
}

/**
 * Token for a named {@link TaskoraRef}. The default slot is provided via
 * the `TaskoraRef` class token itself so `constructor(private tasks:
 * TaskoraRef)` works without a decorator — only call this helper for
 * multi-app setups that need `@InjectTaskoraRef('secondary')`.
 */
export function getTaskoraRefToken(name: string = DEFAULT_APP_NAME): string {
  return `TASKORA_REF:${name}`;
}

/**
 * Token for a per-contract {@link BoundTask} provider created by
 * `TaskoraModule.forFeature([...contracts])`. You rarely need this
 * directly — `@InjectTask(contract)` resolves it for you.
 */
export function getTaskToken(
  contract: TaskContract<any, any>,
  appName: string = DEFAULT_APP_NAME,
): string {
  return `TASKORA_TASK:${appName}:${contract.name}`;
}
