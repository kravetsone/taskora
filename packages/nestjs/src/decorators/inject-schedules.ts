import { Inject } from "@nestjs/common";
import { DEFAULT_APP_NAME, getSchedulesToken } from "../tokens.js";

/**
 * Inject a taskora app's schedule manager (`app.schedules`). The
 * concrete class (`ScheduleManager`) is not exported from taskora's
 * public surface, so this decorator always uses a string token — the
 * type annotation side is up to the caller:
 *
 * ```ts
 * import type { App } from "taskora"
 *
 * constructor(@InjectSchedules() private schedules: App["schedules"]) {}
 * ```
 */
export const InjectSchedules = (name?: string): ParameterDecorator =>
  Inject(getSchedulesToken(name ?? DEFAULT_APP_NAME));
