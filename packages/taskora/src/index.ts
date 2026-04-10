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
  CancelledError,
  SchemaVersionMismatchError,
} from "./errors.js";
export {
  WIRE_VERSION,
  MIN_COMPAT_VERSION,
  type SchemaMeta,
  type CompatResult,
  currentMeta,
  checkCompat,
  writtenByForWireVersion,
} from "./wire-version.js";
export { json } from "./serializer.js";
export { type TaskoraOptions, App } from "./app.js";
export { Task } from "./task.js";
export { BoundTask } from "./bound-task.js";
export {
  type TaskContract,
  type DefineTaskConfig,
  type StaticContractConfig,
  defineTask,
  staticContract,
  isTaskContract,
} from "./contract.js";
export { ResultHandle } from "./result.js";
export { Inspector } from "./inspector.js";
export { DeadLetterManager } from "./dlq.js";
export { into } from "./migration.js";
export { compose } from "./middleware.js";
export { parseDuration, type Duration } from "./scheduler/duration.js";
export {
  Signature,
  ChainSignature,
  GroupSignature,
  ChordSignature,
  WorkflowHandle,
  chain,
  group,
  chord,
  type WorkflowDispatchOptions,
  type WorkflowGraph,
  type WorkflowNode,
} from "./workflow/index.js";

import { App, type TaskoraOptions } from "./app.js";

export function createTaskora(options: TaskoraOptions) {
  return new App(options);
}
