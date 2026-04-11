import type { ModuleMetadata } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import type { App, ResultHandle, TaskContract, Taskora } from "taskora";
import { TaskoraRef } from "../taskora-ref.js";
import { getAppToken } from "../tokens.js";
import {
  TaskoraTestingModule,
  type TaskoraTestingModuleOptions,
} from "./taskora-testing.module.js";

/**
 * Options for {@link createTaskoraTestHarness}. Mirrors
 * `Test.createTestingModule` metadata (`imports`, `providers`,
 * `controllers`, `exports`) with an extra `taskora` field to tweak
 * the underlying {@link TaskoraTestingModule.forRoot} call.
 */
export interface TaskoraTestHarnessOptions extends ModuleMetadata {
  /**
   * Options forwarded to `TaskoraTestingModule.forRoot`. Defaults
   * apply when omitted (memory adapter + `autoStart: true` — the
   * harness always needs a running app so dispatched jobs actually
   * execute).
   */
  taskora?: TaskoraTestingModuleOptions;
}

export interface ExecuteResult<TOutput> {
  id: string;
  state: Taskora.JobState;
  result: TOutput | undefined;
  error: string | undefined;
  attempts: number;
  logs: Taskora.LogEntry[];
  progress: number | Record<string, unknown> | undefined;
  timeline: { dispatched: number; processed?: number; finished?: number };
}

/**
 * End-to-end test harness for Nest modules that use
 * `@taskora/nestjs`.
 *
 * Compiles a {@link TaskoraTestingModule.forRoot} module with your
 * providers, runs `init()` (which fires the discovery pass so every
 * `@TaskConsumer` gets registered), and starts the taskora {@link App}
 * so dispatched jobs actually execute. A single {@link TaskoraRef} is
 * cached on the harness so `.dispatch()` / `.execute()` route through
 * the same app your consumers live on.
 *
 * ```ts
 * const harness = await createTaskoraTestHarness({
 *   providers: [EmailConsumer, MailerService],
 * })
 *
 * const result = await harness.execute(sendEmailTask, { to: "a@b.c" })
 * expect(result.state).toBe("completed")
 * expect(result.result).toEqual({ sent: true, messageId: "..." })
 *
 * await harness.close()
 * ```
 *
 * Because the harness runs the **real** App.start() pipeline — worker
 * loop, subscribe stream, event emitter — `@OnTaskEvent` bindings
 * fire exactly like they would in production. If you need virtual
 * time or want to drive handlers inline without the queue, reach for
 * `taskora/test`'s `createTestRunner()` directly and wire it against
 * a fresh App; the harness deliberately doesn't try to merge both
 * worlds because dual-backend setups are easy to get wrong.
 */
export class TaskoraTestHarness {
  constructor(
    readonly moduleRef: TestingModule,
    readonly app: App,
    readonly tasks: TaskoraRef,
  ) {}

  /**
   * Dispatch a job by contract and return the {@link ResultHandle}
   * synchronously. Pair with `await handle.result` if you just want
   * the eventual output, or call {@link execute} for a richer
   * snapshot of the job's final state.
   */
  dispatch<TInput, TOutput>(
    contract: TaskContract<TInput, TOutput>,
    data: TInput,
    options?: Taskora.DispatchOptions,
  ): ResultHandle<TOutput> {
    return this.tasks.for(contract).dispatch(data, options);
  }

  /**
   * Dispatch + await terminal state, returning a compact summary. If
   * the handler threw, `state` is `"failed"` and `error` carries the
   * message — errors are NOT re-thrown so tests can assert on failure
   * paths without try/catch clutter.
   */
  async execute<TInput, TOutput>(
    contract: TaskContract<TInput, TOutput>,
    data: TInput,
    options?: Taskora.DispatchOptions,
  ): Promise<ExecuteResult<TOutput>> {
    // Fail fast if the contract isn't registered — otherwise dispatch would
    // succeed, the worker would never pick up the job (no implementer), and
    // `await handle.result` would hang until vitest timed out.
    const task = this.app.getTaskByName(contract.name);
    if (!task) {
      throw new Error(
        `TaskoraTestHarness.execute: no task "${contract.name}" is registered on the harness app. ` +
          `Did you forget to add a @TaskConsumer(${contract.name}) provider to the harness providers array?`,
      );
    }

    const handle = this.dispatch(contract, data, options);
    try {
      await handle.result;
    } catch {
      // Swallow — we'll read the failure state from the inspector below.
    }

    // Cross-task search by job ID — iterates every registered task's
    // getState() so we don't need a Task reference here.
    const details = (await this.app.inspect().find(handle.id)) as Taskora.JobInfo<
      TInput,
      TOutput
    > | null;
    if (!details) {
      throw new Error(
        `TaskoraTestHarness.execute: job "${handle.id}" disappeared before the inspector could read it. This usually means retention trimmed it mid-test — increase retention or assert right after dispatch.`,
      );
    }

    return {
      id: handle.id,
      state: details.state,
      result: details.result as TOutput | undefined,
      error: details.error,
      attempts: details.attempt,
      logs: details.logs,
      progress: details.progress,
      timeline: {
        dispatched: details.timestamp,
        processed: details.processedOn,
        finished: details.finishedOn,
      },
    };
  }

  /**
   * Fetch the full `JobInfo` record from the harness app's inspector.
   * Use this when you want fields beyond what {@link execute} returns
   * (e.g. raw data, version, task, migrate chain).
   */
  async inspect<TInput, TOutput>(
    contract: TaskContract<TInput, TOutput>,
    jobId: string,
  ): Promise<Taskora.JobInfo<TInput, TOutput> | null> {
    const task = this.app.getTaskByName(contract.name);
    if (!task) return null;
    return this.app.inspect().find(task, jobId) as Promise<Taskora.JobInfo<TInput, TOutput> | null>;
  }

  /** Tears down the Nest testing module (triggers explorer.shutdown → app.close()). */
  async close(): Promise<void> {
    await this.moduleRef.close();
  }
}

/**
 * Convenience builder for {@link TaskoraTestHarness}. Compiles a Nest
 * testing module with `TaskoraTestingModule.forRoot({ autoStart: true })`
 * pre-imported, runs `init()` so the explorer pass wires every
 * `@TaskConsumer`, and returns a harness that routes `dispatch` /
 * `execute` through the running app.
 *
 * ```ts
 * const harness = await createTaskoraTestHarness({
 *   providers: [EmailConsumer, MailerService],
 *   imports: [ConfigModule.forRoot()],  // any other Nest modules you need
 * })
 * ```
 */
export async function createTaskoraTestHarness(
  options: TaskoraTestHarnessOptions = {},
): Promise<TaskoraTestHarness> {
  const { taskora: taskoraOpts, imports = [], providers = [], controllers, exports } = options;

  const moduleRef = await Test.createTestingModule({
    imports: [TaskoraTestingModule.forRoot({ autoStart: true, ...taskoraOpts }), ...imports],
    providers,
    controllers,
    exports,
  }).compile();

  moduleRef.enableShutdownHooks();
  await moduleRef.init();

  const appName = taskoraOpts?.name;
  const app = moduleRef.get<App>(getAppToken(appName));
  const tasks = moduleRef.get(TaskoraRef);

  return new TaskoraTestHarness(moduleRef, app, tasks);
}
