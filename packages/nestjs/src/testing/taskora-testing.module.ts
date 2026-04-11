import { type DynamicModule, Module } from "@nestjs/common";
import { memoryAdapter } from "taskora/memory";
import type { TaskoraModuleOptions } from "../interfaces/module-options.js";
import { TaskoraModule } from "../taskora.module.js";

/**
 * Options accepted by {@link TaskoraTestingModule.forRoot}. Everything
 * a real `TaskoraModule.forRoot` takes is valid here — the only
 * difference is that `adapter` is optional and defaults to
 * `memoryAdapter()`, and `autoStart` defaults to `false` so the
 * blocking worker loop never attaches (use the
 * {@link TaskoraTestHarness} if you need to actually drive jobs).
 */
export interface TaskoraTestingModuleOptions extends Omit<TaskoraModuleOptions, "adapter"> {
  adapter?: TaskoraModuleOptions["adapter"];
}

/**
 * Drop-in replacement for `TaskoraModule.forRoot` in unit tests.
 *
 * ```ts
 * const moduleRef = await Test.createTestingModule({
 *   imports: [TaskoraTestingModule.forRoot()],
 *   providers: [EmailConsumer, MailerService],
 * }).compile()
 * await moduleRef.init()
 * ```
 *
 * Defaults:
 *   - `adapter` → `memoryAdapter()` (no Redis, no Docker)
 *   - `autoStart` → `false` (no worker loop, no hanging close())
 *
 * Both defaults are override-able: pass `adapter: redisAdapter(...)` if
 * you need to run an integration test against a real backend, or
 * `autoStart: true` if you want the full worker loop. For driving
 * individual jobs without a worker, reach for
 * {@link createTaskoraTestHarness} instead — it wires a taskora
 * `TestRunner` over the same App so you can call `.execute(contract,
 * data)` and get a full `ExecutionResult` back.
 */
@Module({})
export class TaskoraTestingModule {
  static forRoot(options: TaskoraTestingModuleOptions = {}): DynamicModule {
    const merged: TaskoraModuleOptions = {
      adapter: options.adapter ?? memoryAdapter(),
      autoStart: options.autoStart ?? false,
      ...stripDefaults(options),
    };

    return {
      module: TaskoraTestingModule,
      imports: [TaskoraModule.forRoot(merged)],
    };
  }
}

function stripDefaults(
  options: TaskoraTestingModuleOptions,
): Omit<TaskoraTestingModuleOptions, "adapter" | "autoStart"> {
  const { adapter: _adapter, autoStart: _autoStart, ...rest } = options;
  return rest;
}
