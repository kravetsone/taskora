import { type DynamicModule, Module, type Provider } from "@nestjs/common";
import type { App, TaskContract } from "taskora";
import type {
  TaskoraModuleAsyncOptions,
  TaskoraModuleOptions,
} from "./interfaces/module-options.js";
import { TaskoraCoreModule } from "./taskora-core.module.js";
import { DEFAULT_APP_NAME, getAppToken, getTaskToken } from "./tokens.js";

/**
 * Public entry point for the NestJS integration.
 *
 * ```ts
 * @Module({
 *   imports: [
 *     TaskoraModule.forRoot({
 *       adapter: redisAdapter({ client: new Redis(process.env.REDIS_URL!) }),
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * For configuration coming from `ConfigService` or another provider, use
 * {@link TaskoraModule.forRootAsync}:
 *
 * ```ts
 * TaskoraModule.forRootAsync({
 *   useFactory: (cfg: ConfigService) => ({
 *     adapter: redisAdapter({ client: new Redis(cfg.get("REDIS_URL")!) }),
 *   }),
 *   inject: [ConfigService],
 * })
 * ```
 *
 * `TaskoraRef` is auto-provided by `forRoot` / `forRootAsync` — inject it
 * anywhere and call `.for(contract)` for type-safe dispatchers. Reach for
 * {@link TaskoraModule.forFeature} only when you want per-contract DI
 * tokens resolvable via `@InjectTask(contract)`.
 */
@Module({})
export class TaskoraModule {
  static forRoot(options: TaskoraModuleOptions): DynamicModule {
    return {
      module: TaskoraModule,
      imports: [TaskoraCoreModule.forRoot(options)],
    };
  }

  static forRootAsync(asyncOptions: TaskoraModuleAsyncOptions): DynamicModule {
    return {
      module: TaskoraModule,
      imports: [TaskoraCoreModule.forRootAsync(asyncOptions)],
    };
  }

  /**
   * Registers per-contract `BoundTask` providers that can be pulled with
   * `@InjectTask(contract)`. Optional — the preferred path is
   * `constructor(private tasks: TaskoraRef) {}` with
   * `this.tasks.for(contract).dispatch(...)`, which needs no forFeature
   * at all and preserves the contract's generic types without a manual
   * `BoundTask<Input, Output>` annotation.
   *
   * Pass `appName` for multi-app setups to bind these feature providers
   * to a specific `TaskoraModule.forRoot({ name: '...' })` instance.
   */
  static forFeature(
    contracts: TaskContract<any, any>[],
    appName: string = DEFAULT_APP_NAME,
  ): DynamicModule {
    const appToken = getAppToken(appName);

    const providers: Provider[] = contracts.map((contract) => ({
      provide: getTaskToken(contract, appName),
      useFactory: (app: App) => app.register(contract),
      inject: [appToken],
    }));

    return {
      module: TaskoraModule,
      providers,
      exports: providers.map((p) => (p as { provide: string }).provide),
    };
  }
}
