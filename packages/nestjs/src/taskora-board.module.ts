import { type DynamicModule, Module, type Provider } from "@nestjs/common";
import type { App } from "taskora";
import { DEFAULT_APP_NAME, getAppToken, getBoardToken } from "./tokens.js";

/**
 * Configuration for {@link TaskoraBoardModule.forRoot}. Everything
 * except `name` and `app` passes straight through to
 * `@taskora/board`'s `createBoard(app, options)` — see the board
 * package for the full `BoardOptions` shape (basePath, auth,
 * readOnly, redact, formatters, etc.).
 *
 * Kept as a deliberately loose type so @taskora/nestjs doesn't have
 * to reach into the `@taskora/board` types at package-load time
 * (keeps the optional peer dep truly optional).
 */
export interface TaskoraBoardModuleOptions {
  /** Registers the board against a specific named app (default: the default app). */
  name?: string;
  /** Pick a name for the board slot itself — rarely needed, defaults to the app name. */
  board?: string;
  /** Every option below is passed directly to `createBoard(app, options)`. */
  basePath?: string;
  readOnly?: boolean;
  auth?: unknown;
  title?: string;
  logo?: string;
  favicon?: string;
  redact?: string[];
  theme?: "light" | "dark" | "auto";
  refreshInterval?: number;
  cors?: { origin?: string };
  formatters?: {
    data?: (data: unknown, taskName: string) => unknown;
    result?: (result: unknown, taskName: string) => unknown;
  };
}

/**
 * Exposes a `@taskora/board` {@link Board} instance as a Nest provider
 * so it can be injected into services with {@link InjectBoard}.
 *
 * `@taskora/board` is an **optional** peer dependency of
 * `@taskora/nestjs` — install it only when you want the admin
 * dashboard. `TaskoraBoardModule.forRoot` dynamically imports
 * `@taskora/board` via an async factory so the main bundle stays lean
 * when the board isn't used.
 *
 * ## Mounting the board on your HTTP server
 *
 * The board is a Hono app, not an Express or Fastify router. Nest's
 * standard HTTP adapters don't natively speak Hono, so the board is
 * mounted from `main.ts` with a small Web-standard bridge:
 *
 * ```ts
 * // main.ts — Node + Express
 * import { NestFactory } from "@nestjs/core"
 * import { getRequestListener } from "@hono/node-server"
 * import type { Board } from "@taskora/board"
 * import { getBoardToken } from "@taskora/nestjs"
 *
 * async function bootstrap() {
 *   const app = await NestFactory.create(AppModule)
 *   const board = app.get<Board>(getBoardToken())
 *   app.use("/board", getRequestListener(board.fetch))
 *   await app.listen(3000)
 * }
 * ```
 *
 * For Fastify, use `@hono/node-server`'s Fastify adapter or Fastify's
 * `raw` request fall-through. For Bun's HTTP server, call
 * `board.fetch` directly in a `Bun.serve` handler.
 *
 * ## Registration
 *
 * ```ts
 * @Module({
 *   imports: [
 *     TaskoraModule.forRoot({ adapter: redisAdapter(…) }),
 *     TaskoraBoardModule.forRoot({
 *       basePath: "/board",
 *       auth: {
 *         cookiePassword: process.env.BOARD_COOKIE_PASSWORD!,
 *         authenticate: async ({ username, password }) => { … },
 *       },
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 */
@Module({})
export class TaskoraBoardModule {
  static forRoot(options: TaskoraBoardModuleOptions = {}): DynamicModule {
    const appName = options.name ?? DEFAULT_APP_NAME;
    const boardName = options.board ?? appName;
    const appToken = getAppToken(appName);
    const boardToken = getBoardToken(boardName);

    const { name: _name, board: _board, ...boardOptions } = options;

    const provider: Provider = {
      provide: boardToken,
      useFactory: async (app: App) => {
        // Dynamic import keeps @taskora/board as a truly optional peer dep —
        // it's only loaded when TaskoraBoardModule.forRoot is actually used,
        // so consumers of @taskora/nestjs who don't need the board never pay
        // the startup or bundle cost.
        const mod = await import("@taskora/board");
        return mod.createBoard(app, boardOptions);
      },
      inject: [appToken],
    };

    return {
      module: TaskoraBoardModule,
      providers: [provider],
      exports: [boardToken],
    };
  }
}
