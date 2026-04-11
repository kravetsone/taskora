// @taskora/nestjs — NestJS integration for taskora.
//
// Phase 1 (this slice): TaskoraCoreModule, TaskoraModule.forRoot{Async},
// Nest lifecycle wiring (start on bootstrap, close on shutdown), and
// `@InjectApp()` for raw App access.
//
// Upcoming phases:
//   2. forFeature + @InjectTask + TaskoraRef (contract-driven dispatchers)
//   3. @TaskConsumer explorer + @OnTaskEvent wiring
//   4. Class middleware + @InjectInspector / @InjectDeadLetters / @InjectSchedules
//   5. Board middleware mount + multi-app scoping
//   6. @taskora/nestjs/testing

export { TaskoraModule } from "./taskora.module.js";
export { TaskoraCoreModule } from "./taskora-core.module.js";
export { TaskoraLifecycle } from "./lifecycle.js";
export { InjectApp } from "./decorators/inject-app.js";
export {
  DEFAULT_APP_NAME,
  getAppToken,
  getLifecycleToken,
  getOptionsToken,
} from "./tokens.js";
export type {
  TaskoraModuleOptions,
  TaskoraModuleAsyncOptions,
  TaskoraModuleOptionsFactory,
} from "./interfaces/module-options.js";
