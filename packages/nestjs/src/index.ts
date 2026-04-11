// @taskora/nestjs — NestJS integration for taskora.
//
// Phases landed:
//   1. TaskoraCoreModule + forRoot/forRootAsync + lifecycle + @InjectApp
//   2. TaskoraRef + forFeature + @InjectTask
//   3. @TaskConsumer + @OnTaskEvent + TaskoraExplorer
//   4. Class middleware + @InjectInspector / @InjectDeadLetters /
//      @InjectSchedules + InferBoundTask helper (this slice)
//
// Upcoming phases:
//   5. @taskora/board middleware mount + multi-app scoping
//   6. @taskora/nestjs/testing

export { TaskoraModule } from "./taskora.module.js";
export { TaskoraCoreModule } from "./taskora-core.module.js";
export { TaskoraExplorer } from "./taskora-explorer.js";
export { TaskoraRef } from "./taskora-ref.js";

// Decorators — producer side
export { InjectApp } from "./decorators/inject-app.js";
export { InjectTask } from "./decorators/inject-task.js";
export { InjectTaskoraRef } from "./decorators/inject-taskora-ref.js";

// Decorators — consumer side
export { TaskConsumer } from "./decorators/task-consumer.js";
export { OnTaskEvent } from "./decorators/on-task-event.js";
export { TaskMiddleware } from "./decorators/task-middleware.js";

// Decorators — observability / admin accessors
export { InjectInspector } from "./decorators/inject-inspector.js";
export { InjectDeadLetters } from "./decorators/inject-dead-letters.js";
export { InjectSchedules } from "./decorators/inject-schedules.js";

// Tokens
export {
  DEFAULT_APP_NAME,
  getAppToken,
  getDeadLettersToken,
  getExplorerToken,
  getInspectorToken,
  getOptionsToken,
  getSchedulesToken,
  getTaskToken,
  getTaskoraRefToken,
} from "./tokens.js";

// Metadata + types
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
export type { TaskoraMiddleware } from "./interfaces/taskora-middleware.js";

// Type helpers
export type { InferBoundTask } from "./infer.js";
// Re-export the taskora inference helpers as a convenience — callers don't
// have to add a second `import type { InferInput } from "taskora"` if they
// already pulled the helpers from @taskora/nestjs.
export type { InferInput, InferOutput } from "taskora";
