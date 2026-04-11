import {
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type Type,
} from "@nestjs/common";
import type { DiscoveryService, MetadataScanner } from "@nestjs/core";
import type { App, Taskora } from "taskora";
import type { TaskoraMiddleware } from "./interfaces/taskora-middleware.js";
import {
  ON_TASK_EVENT_METADATA,
  TASK_CONSUMER_METADATA,
  type TaskConsumerMetadata,
  type TaskConsumerOptions,
  type TaskEventBinding,
} from "./metadata.js";
import { DEFAULT_APP_NAME } from "./tokens.js";

type ConsumerInstance = {
  process?: (data: unknown, ctx: Taskora.Context) => unknown | Promise<unknown>;
  [key: string]: unknown;
};

/**
 * Per-app discovery + lifecycle driver.
 *
 * One {@link TaskoraExplorer} instance is created for every
 * `TaskoraModule.forRoot({ name })` call. On `onApplicationBootstrap`
 * it:
 *
 *   1. Iterates providers via Nest's DiscoveryService.
 *   2. Picks up every class decorated with `@TaskConsumer(contract)`
 *      whose `app` option matches this explorer's `appName`.
 *   3. Calls `app.implement(contract, handler)` where the handler is
 *      a closure that delegates to the **DI-managed instance**'s
 *      `process()` method — so constructor-injected dependencies stay
 *      live across job runs.
 *   4. Wires every `@OnTaskEvent` method on the consumer to
 *      `task.on(event, …)` so Nest providers receive per-task events.
 *   5. Calls `app.start()` (unless `autoStart: false`) to spin up
 *      worker loops AFTER all handlers are attached — the ordering is
 *      critical, otherwise the worker could start polling before any
 *      contract is implemented.
 *
 * On `onApplicationShutdown` it awaits `app.close()` so in-flight jobs
 * are drained gracefully under SIGTERM.
 */
export class TaskoraExplorer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TaskoraExplorer.name);

  constructor(
    private readonly app: App,
    private readonly appName: string,
    private readonly autoStart: boolean,
    private readonly middlewareClasses: Type<TaskoraMiddleware>[],
    private readonly discovery: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.registerMiddleware();
    this.registerConsumers();
    if (this.autoStart) await this.app.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.app.close();
  }

  private registerMiddleware(): void {
    if (this.middlewareClasses.length === 0) return;

    const wrappers = this.discovery.getProviders();
    const byMetatype = new Map<unknown, unknown>();
    for (const wrapper of wrappers) {
      if (wrapper.metatype && wrapper.instance) {
        byMetatype.set(wrapper.metatype, wrapper.instance);
      }
    }

    for (const cls of this.middlewareClasses) {
      const instance = byMetatype.get(cls) as TaskoraMiddleware | undefined;
      if (!instance) {
        throw new Error(
          `TaskoraModule middleware ${cls.name} was listed in forRoot({ middleware }) but no DI instance was found. Make sure it is included in the owning module's providers: [${cls.name}] array.`,
        );
      }
      if (typeof instance.use !== "function") {
        throw new Error(
          `${cls.name} was registered as middleware but does not implement use(ctx, next).`,
        );
      }
      this.app.use(((ctx, next) => instance.use(ctx, next)) as Taskora.Middleware);
      this.logger.log(
        `Registered @TaskMiddleware ${cls.name}${
          this.appName === DEFAULT_APP_NAME ? "" : ` (app: ${this.appName})`
        }`,
      );
    }
  }

  private registerConsumers(): void {
    const wrappers = this.discovery.getProviders();
    for (const wrapper of wrappers) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;

      const meta = Reflect.getMetadata(TASK_CONSUMER_METADATA, metatype) as
        | TaskConsumerMetadata
        | undefined;
      if (!meta) continue;

      const consumerAppName = meta.options.app ?? DEFAULT_APP_NAME;
      if (consumerAppName !== this.appName) continue;

      this.implementConsumer(instance as ConsumerInstance, metatype, meta);
    }
  }

  private implementConsumer(
    instance: ConsumerInstance,
    metatype: { name: string; prototype: object },
    meta: TaskConsumerMetadata,
  ): void {
    if (typeof instance.process !== "function") {
      throw new Error(
        `@TaskConsumer class "${metatype.name}" must implement a \`process(data, ctx)\` method`,
      );
    }

    const { contract, options } = meta;
    const handler = (data: unknown, ctx: Taskora.Context) =>
      (instance.process as NonNullable<ConsumerInstance["process"]>).call(instance, data, ctx);

    this.app.implement(
      contract,
      handler as Parameters<App["implement"]>[1],
      stripAppField(options),
    );

    this.wireEventHandlers(instance, metatype, contract.name);

    this.logger.log(
      `Registered @TaskConsumer ${metatype.name} → task "${contract.name}"${
        this.appName === DEFAULT_APP_NAME ? "" : ` (app: ${this.appName})`
      }`,
    );
  }

  private wireEventHandlers(
    instance: ConsumerInstance,
    metatype: { name: string; prototype: object },
    taskName: string,
  ): void {
    const bindings =
      (Reflect.getMetadata(ON_TASK_EVENT_METADATA, metatype) as TaskEventBinding[] | undefined) ??
      [];
    if (bindings.length === 0) return;

    const task = this.app.getTaskByName(taskName);
    if (!task) {
      // Shouldn't happen — implement() just created it — but guard anyway.
      return;
    }

    // Walk the method list once via MetadataScanner so subclasses' inherited
    // methods are accessible; Reflect.getMetadata on bindings already has the
    // resolved method names, we only use the scanner here to assert the
    // method exists on the instance (catches typos in @OnTaskEvent usage).
    const methodNames = new Set(this.metadataScanner.getAllMethodNames(metatype.prototype));

    for (const { event, method } of bindings) {
      if (typeof method === "string" && !methodNames.has(method)) {
        this.logger.warn(
          `@OnTaskEvent("${event}") on ${metatype.name}.${String(method)} — method not found on instance; skipping.`,
        );
        continue;
      }
      const fn = (instance as Record<string | symbol, unknown>)[method];
      if (typeof fn !== "function") continue;
      task.on(
        event as keyof Taskora.TaskEventMap<unknown>,
        ((...args: unknown[]) =>
          (fn as (...a: unknown[]) => unknown).apply(instance, args)) as never,
      );
    }
  }
}

function stripAppField(options: TaskConsumerOptions): Omit<TaskConsumerOptions, "app"> {
  const { app: _app, ...rest } = options;
  return rest;
}
