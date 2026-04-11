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
