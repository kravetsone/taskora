// @taskora/nestjs/testing — opt-in subpath for unit-testing Nest modules
// that depend on @taskora/nestjs without pulling in Redis / testcontainers.
//
// The two entry points:
//
//   TaskoraTestingModule.forRoot(options?)
//     Drop-in replacement for TaskoraModule.forRoot in Test.createTestingModule
//     calls. Defaults adapter to memoryAdapter() and autoStart to false.
//
//   createTaskoraTestHarness({ providers, imports, taskora? })
//     Higher-level builder: compiles a TestingModule, initialises the
//     explorer so @TaskConsumer handlers are registered, and wires a
//     taskora TestRunner over the same App. Returns a TaskoraTestHarness
//     that exposes execute / run / dispatch / advanceTime / close and
//     lets you drive individual jobs through the DI-managed consumer
//     instances without any worker loop.
//
// Both tools reuse the production explorer / lifecycle / middleware
// wiring from the main @taskora/nestjs export — you're not testing a
// parallel implementation, you're driving the real one over an
// in-memory adapter.

export {
  TaskoraTestingModule,
  type TaskoraTestingModuleOptions,
} from "./taskora-testing.module.js";
export {
  TaskoraTestHarness,
  type TaskoraTestHarnessOptions,
  type ExecuteResult,
  createTaskoraTestHarness,
} from "./taskora-test-harness.js";
