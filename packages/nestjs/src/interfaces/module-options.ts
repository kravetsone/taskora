import type { ModuleMetadata, Type } from "@nestjs/common";
import type { TaskoraOptions } from "taskora";

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
}

export interface TaskoraModuleOptionsFactory {
  createTaskoraOptions(): Promise<TaskoraOptions> | TaskoraOptions;
}

export interface TaskoraModuleAsyncOptions extends Pick<ModuleMetadata, "imports"> {
  name?: string;
  autoStart?: boolean;
  useFactory?: (...args: any[]) => Promise<TaskoraOptions> | TaskoraOptions;
  inject?: any[];
  useClass?: Type<TaskoraModuleOptionsFactory>;
  useExisting?: Type<TaskoraModuleOptionsFactory>;
}
