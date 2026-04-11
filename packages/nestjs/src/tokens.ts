import type { TaskContract } from "taskora";

export const DEFAULT_APP_NAME = "default";

export function getAppToken(name: string = DEFAULT_APP_NAME): string {
  return `TASKORA_APP:${name}`;
}

export function getOptionsToken(name: string = DEFAULT_APP_NAME): string {
  return `TASKORA_OPTIONS:${name}`;
}

/**
 * Token for a named {@link TaskoraExplorer}. One explorer is created
 * per app, owns the discovery-based consumer registration, and drives
 * the `app.start()` / `app.close()` lifecycle for that app.
 */
export function getExplorerToken(name: string = DEFAULT_APP_NAME): string {
  return `TASKORA_EXPLORER:${name}`;
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

export function getInspectorToken(name: string = DEFAULT_APP_NAME): string {
  return `TASKORA_INSPECTOR:${name}`;
}

export function getDeadLettersToken(name: string = DEFAULT_APP_NAME): string {
  return `TASKORA_DLQ:${name}`;
}

export function getSchedulesToken(name: string = DEFAULT_APP_NAME): string {
  return `TASKORA_SCHEDULES:${name}`;
}

/**
 * Token for a named `@taskora/board` {@link Board} provider created
 * by `TaskoraBoardModule.forRoot(...)`. Always string-keyed because
 * `Board` is a runtime-imported interface from an optional peer dep,
 * not a class we can use as a DI class token.
 */
export function getBoardToken(name: string = DEFAULT_APP_NAME): string {
  return `TASKORA_BOARD:${name}`;
}
