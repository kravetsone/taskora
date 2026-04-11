import { type DynamicModule, Module } from "@nestjs/common";
import type {
  TaskoraModuleAsyncOptions,
  TaskoraModuleOptions,
} from "./interfaces/module-options.js";
import { TaskoraCoreModule } from "./taskora-core.module.js";

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
}
