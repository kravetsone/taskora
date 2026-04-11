// @taskora/nestjs — NestJS integration for taskora.
//
// Phases landed:
//   1. TaskoraCoreModule + forRoot/forRootAsync + lifecycle + @InjectApp
//   2. TaskoraRef + forFeature + @InjectTask
//   3. @TaskConsumer + @OnTaskEvent + TaskoraExplorer (this slice)
//
// Upcoming phases:
//   4. Class middleware + @InjectInspector / @InjectDeadLetters / @InjectSchedules
//   5. @taskora/board middleware mount + multi-app scoping
//   6. @taskora/nestjs/testing

export { TaskoraModule } from "./taskora.module.js";
export { TaskoraCoreModule } from "./taskora-core.module.js";
export { TaskoraExplorer } from "./taskora-explorer.js";
export { TaskoraRef } from "./taskora-ref.js";
export { InjectApp } from "./decorators/inject-app.js";
export { InjectTask } from "./decorators/inject-task.js";
export { InjectTaskoraRef } from "./decorators/inject-taskora-ref.js";
export { TaskConsumer } from "./decorators/task-consumer.js";
export { OnTaskEvent } from "./decorators/on-task-event.js";
export {
  DEFAULT_APP_NAME,
  getAppToken,
  getExplorerToken,
  getOptionsToken,
  getTaskToken,
  getTaskoraRefToken,
} from "./tokens.js";
export {
  TASK_CONSUMER_METADATA,
  ON_TASK_EVENT_METADATA,
  type TaskConsumerOptions,
  type TaskConsumerMetadata,
  type TaskEventBinding,
} from "./metadata.js";
export type {
  TaskoraModuleOptions,
  TaskoraModuleAsyncOptions,
  TaskoraModuleOptionsFactory,
} from "./interfaces/module-options.js";
