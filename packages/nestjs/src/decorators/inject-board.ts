import { Inject } from "@nestjs/common";
import { getBoardToken } from "../tokens.js";

/**
 * Inject a `@taskora/board` {@link Board} instance registered via
 * {@link TaskoraBoardModule.forRoot}. Pass the same `name` that was
 * given to `TaskoraBoardModule.forRoot({ name })` for multi-board
 * setups; omit it for the default slot.
 *
 * Because `@taskora/board` is an optional peer dep, the `Board` type
 * itself has to be imported from `@taskora/board` by callers — the
 * `@taskora/nestjs` package deliberately doesn't re-export it to keep
 * the core bundle free of board types:
 *
 * ```ts
 * import type { Board } from "@taskora/board"
 *
 * class DashboardService {
 *   constructor(@InjectBoard() private readonly board: Board) {}
 * }
 * ```
 */
export const InjectBoard = (name?: string): ParameterDecorator => Inject(getBoardToken(name));
