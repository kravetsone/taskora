// @taskora/nestjs — NestJS integration for taskora.
//
// Phases landed:
//   1. TaskoraCoreModule + forRoot/forRootAsync + lifecycle + @InjectApp
//   2. TaskoraRef + forFeature + @InjectTask (this slice)
//
// Upcoming phases:
//   3. @TaskConsumer explorer + @OnTaskEvent wiring
//   4. Class middleware + @InjectInspector / @InjectDeadLetters / @InjectSchedules
//   5. @taskora/board middleware mount + multi-app scoping
//   6. @taskora/nestjs/testing

export { TaskoraModule } from "./taskora.module.js";
export { TaskoraCoreModule } from "./taskora-core.module.js";
export { TaskoraLifecycle } from "./lifecycle.js";
export { TaskoraRef } from "./taskora-ref.js";
export { InjectApp } from "./decorators/inject-app.js";
export { InjectTask } from "./decorators/inject-task.js";
export { InjectTaskoraRef } from "./decorators/inject-taskora-ref.js";
export {
  DEFAULT_APP_NAME,
  getAppToken,
  getLifecycleToken,
  getOptionsToken,
  getTaskToken,
  getTaskoraRefToken,
} from "./tokens.js";
export type {
  TaskoraModuleOptions,
  TaskoraModuleAsyncOptions,
  TaskoraModuleOptionsFactory,
} from "./interfaces/module-options.js";
