export type { Taskora } from "./types.js";
export {
  TaskoraError,
  ValidationError,
  RetryError,
  StalledError,
} from "./errors.js";
export { json } from "./serializer.js";
export { type TaskoraOptions, App } from "./app.js";
export { Task } from "./task.js";

import { App, type TaskoraOptions } from "./app.js";

export function taskora(options: TaskoraOptions) {
  return new App(options);
}
