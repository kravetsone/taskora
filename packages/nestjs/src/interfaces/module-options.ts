import type { ModuleMetadata, Type } from "@nestjs/common";
import type { TaskoraOptions } from "taskora";
import type { TaskoraMiddleware } from "./taskora-middleware.js";

export interface TaskoraModuleOptions extends TaskoraOptions {
  /**
   * Named app slot — lets you register multiple {@link App} instances in the
   * same Nest container (e.g. one per Redis cluster or per tenant). Leave
   * undefined for single-app setups; {@link InjectApp} without an argument
   * will resolve the default slot.
   */
  name?: string;
  /**
   * Call `app.start()` on `OnApplicationBootstrap`. Default: `true`. Set to
   * `false` for producer-only processes where you know upfront that no task
   * handlers will be implemented — skipping start avoids spinning up worker
   * loops that have nothing to do. Note: `App.start()` already short-circuits
   * when every registered task is contract-only, so you rarely need to touch
   * this flag explicitly.
   */
  autoStart?: boolean;
  /**
   * App-level middleware classes. Each entry must be a Nest provider
   * implementing {@link TaskoraMiddleware}. The explorer resolves the
   * instance from the DI graph and wires its `use()` method via
   * `app.use()` during `onApplicationBootstrap`, in list order (first
   * entry runs outermost).
   *
   * The classes still need to be listed in the owning module's
   * `providers: [...]` array so Nest knows to instantiate them.
   */
  middleware?: Type<TaskoraMiddleware>[];
}

export interface TaskoraModuleOptionsFactory {
  createTaskoraOptions(): Promise<TaskoraOptions> | TaskoraOptions;
}

export interface TaskoraModuleAsyncOptions extends Pick<ModuleMetadata, "imports"> {
  name?: string;
  autoStart?: boolean;
  /** App-level middleware classes. Resolved from the DI graph by the explorer. */
  middleware?: Type<TaskoraMiddleware>[];
  useFactory?: (...args: any[]) => Promise<TaskoraOptions> | TaskoraOptions;
  inject?: any[];
  useClass?: Type<TaskoraModuleOptionsFactory>;
  useExisting?: Type<TaskoraModuleOptionsFactory>;
}
