import { type DynamicModule, Global, Module, type Provider, type Type } from "@nestjs/common";
import { DiscoveryModule, DiscoveryService, MetadataScanner } from "@nestjs/core";
import {
  type App,
  DeadLetterManager,
  Inspector,
  type TaskoraOptions,
  createTaskora,
} from "taskora";
import type {
  TaskoraModuleAsyncOptions,
  TaskoraModuleOptions,
  TaskoraModuleOptionsFactory,
} from "./interfaces/module-options.js";
import type { TaskoraMiddleware } from "./interfaces/taskora-middleware.js";
import { TaskoraExplorer } from "./taskora-explorer.js";
import { TaskoraRef } from "./taskora-ref.js";
import {
  DEFAULT_APP_NAME,
  getAppToken,
  getDeadLettersToken,
  getExplorerToken,
  getInspectorToken,
  getOptionsToken,
  getSchedulesToken,
  getTaskoraRefToken,
} from "./tokens.js";

@Global()
@Module({})
export class TaskoraCoreModule {
  static forRoot(options: TaskoraModuleOptions): DynamicModule {
    const name = options.name ?? DEFAULT_APP_NAME;
    const autoStart = options.autoStart ?? true;
    const middleware = options.middleware ?? [];
    const appToken = getAppToken(name);

    const appProvider: Provider = {
      provide: appToken,
      useFactory: (): App => createTaskora(stripNestFields(options)),
    };

    return {
      module: TaskoraCoreModule,
      global: true,
      imports: [DiscoveryModule],
      providers: [
        appProvider,
        createExplorerProvider(name, autoStart, middleware, appToken),
        createTaskoraRefProvider(name, appToken),
        ...createAccessorProviders(name, appToken),
      ],
      exports: [appProvider, ...taskoraRefExports(name), ...accessorExports(name)],
    };
  }

  static forRootAsync(asyncOptions: TaskoraModuleAsyncOptions): DynamicModule {
    const name = asyncOptions.name ?? DEFAULT_APP_NAME;
    const autoStart = asyncOptions.autoStart ?? true;
    const middleware = asyncOptions.middleware ?? [];
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
      imports: [DiscoveryModule, ...(asyncOptions.imports ?? [])],
      providers: [
        ...asyncProviders,
        appProvider,
        createExplorerProvider(name, autoStart, middleware, appToken),
        createTaskoraRefProvider(name, appToken),
        ...createAccessorProviders(name, appToken),
      ],
      exports: [appProvider, ...taskoraRefExports(name), ...accessorExports(name)],
    };
  }
}

function createExplorerProvider(
  name: string,
  autoStart: boolean,
  middleware: Type<TaskoraMiddleware>[],
  appToken: string,
): Provider {
  return {
    provide: getExplorerToken(name),
    useFactory: (app: App, discovery: DiscoveryService, scanner: MetadataScanner) =>
      new TaskoraExplorer(app, name, autoStart, middleware, discovery, scanner),
    inject: [appToken, DiscoveryService, MetadataScanner],
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

function createAccessorProviders(name: string, appToken: string): Provider[] {
  const isDefault = name === DEFAULT_APP_NAME;

  // Inspector: app.inspect() returns a FRESH instance on every call; cache
  // one per app so @InjectInspector gives a stable reference.
  const inspectorToken = isDefault ? Inspector : getInspectorToken(name);

  // DeadLetterManager: app.deadLetters is a singleton owned by the App, just
  // pass it through.
  const dlqToken = isDefault ? DeadLetterManager : getDeadLettersToken(name);

  // Schedules: no class token (ScheduleManager isn't in taskora's public
  // exports), always string-keyed.
  const schedulesToken = getSchedulesToken(name);

  return [
    {
      provide: inspectorToken,
      useFactory: (app: App) => app.inspect(),
      inject: [appToken],
    },
    {
      provide: dlqToken,
      useFactory: (app: App) => app.deadLetters,
      inject: [appToken],
    },
    {
      provide: schedulesToken,
      useFactory: (app: App) => app.schedules,
      inject: [appToken],
    },
  ];
}

function accessorExports(name: string): (typeof Inspector | typeof DeadLetterManager | string)[] {
  const isDefault = name === DEFAULT_APP_NAME;
  return [
    isDefault ? Inspector : getInspectorToken(name),
    isDefault ? DeadLetterManager : getDeadLettersToken(name),
    getSchedulesToken(name),
  ];
}

function stripNestFields(options: TaskoraModuleOptions): TaskoraOptions {
  const { name: _name, autoStart: _autoStart, middleware: _middleware, ...rest } = options;
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
