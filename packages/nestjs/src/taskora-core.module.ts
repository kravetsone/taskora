import { type DynamicModule, Global, Module, type Provider } from "@nestjs/common";
import { type App, type TaskoraOptions, createTaskora } from "taskora";
import type {
  TaskoraModuleAsyncOptions,
  TaskoraModuleOptions,
  TaskoraModuleOptionsFactory,
} from "./interfaces/module-options.js";
import { TaskoraLifecycle } from "./lifecycle.js";
import { DEFAULT_APP_NAME, getAppToken, getLifecycleToken, getOptionsToken } from "./tokens.js";

@Global()
@Module({})
export class TaskoraCoreModule {
  static forRoot(options: TaskoraModuleOptions): DynamicModule {
    const name = options.name ?? DEFAULT_APP_NAME;
    const autoStart = options.autoStart ?? true;
    const appToken = getAppToken(name);
    const lifecycleToken = getLifecycleToken(name);

    const appProvider: Provider = {
      provide: appToken,
      useFactory: (): App => createTaskora(stripNestFields(options)),
    };

    const lifecycleProvider: Provider = {
      provide: lifecycleToken,
      useFactory: (app: App) => new TaskoraLifecycle(app, autoStart),
      inject: [appToken],
    };

    return {
      module: TaskoraCoreModule,
      global: true,
      providers: [appProvider, lifecycleProvider],
      exports: [appProvider],
    };
  }

  static forRootAsync(asyncOptions: TaskoraModuleAsyncOptions): DynamicModule {
    const name = asyncOptions.name ?? DEFAULT_APP_NAME;
    const autoStart = asyncOptions.autoStart ?? true;
    const appToken = getAppToken(name);
    const optionsToken = getOptionsToken(name);
    const lifecycleToken = getLifecycleToken(name);

    const asyncProviders = createAsyncOptionsProviders(asyncOptions, optionsToken);

    const appProvider: Provider = {
      provide: appToken,
      useFactory: (options: TaskoraOptions): App => createTaskora(options),
      inject: [optionsToken],
    };

    const lifecycleProvider: Provider = {
      provide: lifecycleToken,
      useFactory: (app: App) => new TaskoraLifecycle(app, autoStart),
      inject: [appToken],
    };

    return {
      module: TaskoraCoreModule,
      global: true,
      imports: asyncOptions.imports ?? [],
      providers: [...asyncProviders, appProvider, lifecycleProvider],
      exports: [appProvider],
    };
  }
}

function stripNestFields(options: TaskoraModuleOptions): TaskoraOptions {
  const { name: _name, autoStart: _autoStart, ...rest } = options;
  return rest;
}

function createAsyncOptionsProviders(
  asyncOptions: TaskoraModuleAsyncOptions,
  optionsToken: string,
): Provider[] {
  if (asyncOptions.useFactory) {
    return [
      {
        provide: optionsToken,
        useFactory: asyncOptions.useFactory,
        inject: asyncOptions.inject ?? [],
      },
    ];
  }

  const classRef = asyncOptions.useClass ?? asyncOptions.useExisting;
  if (!classRef) {
    throw new Error("TaskoraModule.forRootAsync() requires useFactory, useClass, or useExisting");
  }

  const providers: Provider[] = [
    {
      provide: optionsToken,
      useFactory: (factory: TaskoraModuleOptionsFactory) => factory.createTaskoraOptions(),
      inject: [classRef],
    },
  ];

  if (asyncOptions.useClass) {
    providers.push({ provide: asyncOptions.useClass, useClass: asyncOptions.useClass });
  }

  return providers;
}
