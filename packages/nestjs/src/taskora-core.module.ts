import { type DynamicModule, Global, Module, type Provider } from "@nestjs/common";
import { type App, type TaskoraOptions, createTaskora } from "taskora";
import type {
  TaskoraModuleAsyncOptions,
  TaskoraModuleOptions,
  TaskoraModuleOptionsFactory,
} from "./interfaces/module-options.js";
import { TaskoraLifecycle } from "./lifecycle.js";
import { TaskoraRef } from "./taskora-ref.js";
import {
  DEFAULT_APP_NAME,
  getAppToken,
  getLifecycleToken,
  getOptionsToken,
  getTaskoraRefToken,
} from "./tokens.js";

@Global()
@Module({})
export class TaskoraCoreModule {
  static forRoot(options: TaskoraModuleOptions): DynamicModule {
    const name = options.name ?? DEFAULT_APP_NAME;
    const autoStart = options.autoStart ?? true;
    const appToken = getAppToken(name);

    const appProvider: Provider = {
      provide: appToken,
      useFactory: (): App => createTaskora(stripNestFields(options)),
    };

    return {
      module: TaskoraCoreModule,
      global: true,
      providers: [
        appProvider,
        createLifecycleProvider(name, autoStart, appToken),
        createTaskoraRefProvider(name, appToken),
      ],
      exports: [appProvider, ...taskoraRefExports(name)],
    };
  }

  static forRootAsync(asyncOptions: TaskoraModuleAsyncOptions): DynamicModule {
    const name = asyncOptions.name ?? DEFAULT_APP_NAME;
    const autoStart = asyncOptions.autoStart ?? true;
    const appToken = getAppToken(name);
    const optionsToken = getOptionsToken(name);

    const asyncProviders = createAsyncOptionsProviders(asyncOptions, optionsToken);

    const appProvider: Provider = {
      provide: appToken,
      useFactory: (options: TaskoraOptions): App => createTaskora(options),
      inject: [optionsToken],
    };

    return {
      module: TaskoraCoreModule,
      global: true,
      imports: asyncOptions.imports ?? [],
      providers: [
        ...asyncProviders,
        appProvider,
        createLifecycleProvider(name, autoStart, appToken),
        createTaskoraRefProvider(name, appToken),
      ],
      exports: [appProvider, ...taskoraRefExports(name)],
    };
  }
}

function createLifecycleProvider(name: string, autoStart: boolean, appToken: string): Provider {
  return {
    provide: getLifecycleToken(name),
    useFactory: (app: App) => new TaskoraLifecycle(app, autoStart),
    inject: [appToken],
  };
}

function createTaskoraRefProvider(name: string, appToken: string): Provider {
  // Default slot is provided via the TaskoraRef class token so callers can
  // write `constructor(private tasks: TaskoraRef) {}` with no decorator.
  // Named slots use string tokens resolved by `@InjectTaskoraRef('name')`.
  const provide = name === DEFAULT_APP_NAME ? TaskoraRef : getTaskoraRefToken(name);
  return {
    provide,
    useFactory: (app: App) => new TaskoraRef(app),
    inject: [appToken],
  };
}

function taskoraRefExports(name: string): (typeof TaskoraRef | string)[] {
  return [name === DEFAULT_APP_NAME ? TaskoraRef : getTaskoraRefToken(name)];
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
