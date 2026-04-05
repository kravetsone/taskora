export type { Taskora } from "./types.js";
export {
  TaskoraError,
  ValidationError,
  RetryError,
  StalledError,
  JobFailedError,
  TimeoutError,
  ThrottledError,
  DuplicateJobError,
  ExpiredError,
} from "./errors.js";
export { json } from "./serializer.js";
export { type TaskoraOptions, App } from "./app.js";
export { Task } from "./task.js";
export { ResultHandle } from "./result.js";
export { Inspector } from "./inspector.js";
export { DeadLetterManager } from "./dlq.js";
export { into } from "./migration.js";
export { compose } from "./middleware.js";
export { parseDuration, type Duration } from "./scheduler/duration.js";

import { App, type TaskoraOptions } from "./app.js";

export function taskora(options: TaskoraOptions) {
  return new App(options);
}
