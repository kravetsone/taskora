import { Injectable } from "@nestjs/common";
import type { TaskContract } from "taskora";
import {
  TASK_CONSUMER_METADATA,
  type TaskConsumerMetadata,
  type TaskConsumerOptions,
} from "../metadata.js";

/**
 * Class-level marker that turns a Nest provider into a taskora worker
 * handler for the given {@link TaskContract}. The class must expose a
 * `process(data, ctx)` method that receives the decoded input and the
 * taskora context. Constructor DI works normally — inject any other
 * provider and the explorer will keep the same instance across job runs.
 *
 * ```ts
 * @TaskConsumer(sendEmailTask, { concurrency: 10, retry: { attempts: 5 } })
 * export class SendEmailConsumer {
 *   constructor(private mailer: MailerService) {}
 *
 *   async process(data: { to: string }, ctx: Taskora.Context) {
 *     return this.mailer.send(data)
 *   }
 *
 *   @OnTaskEvent('completed')
 *   onDone(evt: Taskora.TaskEvent<'completed'>) { … }
 * }
 * ```
 *
 * Register the consumer like any Nest provider:
 *
 * ```ts
 * @Module({ providers: [SendEmailConsumer] })
 * export class EmailModule {}
 * ```
 *
 * The {@link TaskoraExplorer} scans the DI graph during
 * `onApplicationBootstrap`, calls `app.implement(contract, handler)`
 * with the instance's `process` bound as the handler, and wires every
 * `@OnTaskEvent` method to `task.on(event)` before `app.start()` runs.
 */
export function TaskConsumer<TInput, TOutput>(
  contract: TaskContract<TInput, TOutput>,
  options: TaskConsumerOptions = {},
): ClassDecorator {
  return (target: object) => {
    const meta: TaskConsumerMetadata = { contract, options };
    Reflect.defineMetadata(TASK_CONSUMER_METADATA, meta, target);
    // Apply @Injectable() so Nest treats the class as a provider and the
    // explorer picks it up via DiscoveryService. Harmless if the caller
    // already decorated the class with @Injectable explicitly.
    Injectable()(target as (...args: any[]) => any);
  };
}
