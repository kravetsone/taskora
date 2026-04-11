import { ON_TASK_EVENT_METADATA, type TaskEventBinding } from "../metadata.js";

/**
 * Method-level binding that routes a taskora per-task event into a
 * `@TaskConsumer` method. The method receives whatever payload taskora
 * emits for that event — see `Taskora.TaskEventMap` for shapes.
 *
 * ```ts
 * @TaskConsumer(sendEmailTask)
 * export class SendEmailConsumer {
 *   async process(data: Input) { … }
 *
 *   @OnTaskEvent('completed')
 *   onDone(evt: Taskora.TaskEvent<'completed'>) {
 *     this.logger.log(`sent to ${evt.data.to}`)
 *   }
 *
 *   @OnTaskEvent('failed')
 *   onFail(evt: Taskora.TaskEvent<'failed'>) { … }
 * }
 * ```
 *
 * Valid events match the keys of `Taskora.TaskEventMap` —
 * `"completed" | "failed" | "retrying" | "progress" | "active" |
 * "stalled" | "cancelled"`.
 *
 * App-level events (`worker:ready`, `worker:error`, etc.) are not in
 * scope of this decorator — they can be handled by injecting the
 * {@link App} directly and calling `app.on(...)` from a service.
 */
export function OnTaskEvent(event: string): MethodDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const ctor = (target as { constructor: object }).constructor;
    const existing =
      (Reflect.getMetadata(ON_TASK_EVENT_METADATA, ctor) as TaskEventBinding[] | undefined) ?? [];
    existing.push({ event, method: propertyKey });
    Reflect.defineMetadata(ON_TASK_EVENT_METADATA, existing, ctor);
  };
}
