import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { App } from "../app.js";
import { createApi } from "./api.js";
import type { Board, BoardOptions } from "./types.js";

export type { Board, BoardOptions } from "./types.js";

export function createBoard(app: App, options: BoardOptions = {}): Board {
  const basePath = options.basePath ?? "/board";
  const root = new Hono();
  const api = createApi(app, options);

  // Mount API
  root.route(`${basePath}`, api);

  // Serve SPA static files — try static, fallback to index.html for SPA routing
  root.get(`${basePath}/*`, serveStatic({ root: "./dist/board/static" }));
  root.get(`${basePath}/*`, serveStatic({ path: "./dist/board/static/index.html" }));

  // Redirect bare path to basePath/
  root.get(basePath === "/" ? basePath : `${basePath}`, (c) => {
    return c.redirect(`${basePath}/`);
  });

  const honoFetch = root.fetch.bind(root);

  return {
    app: root,
    fetch: honoFetch,
    handler: (req: unknown, res: unknown) => {
      // Node.js (req, res) handler via hono/node-server
      // Users can use @hono/node-server for Express/Koa integration
      // For now, provide the fetch handler and let users adapt
      throw new Error(
        "Use board.fetch for Web standard servers (Bun/Deno) or @hono/node-server for Express/Koa",
      );
    },
    listen: (port: number) => {
      // Standalone mode via Bun.serve or Deno.serve
      const g = globalThis as Record<string, unknown>;
      if (typeof g.Bun !== "undefined") {
        (g.Bun as { serve: (opts: unknown) => void }).serve({ fetch: honoFetch, port });
        console.log(`taskora board listening on http://localhost:${port}${basePath}`);
      } else if (typeof g.Deno !== "undefined") {
        (g.Deno as { serve: (opts: unknown, handler: unknown) => void }).serve({ port }, honoFetch);
        console.log(`taskora board listening on http://localhost:${port}${basePath}`);
      } else {
        throw new Error(
          "board.listen() requires Bun or Deno. For Node.js, use board.fetch with @hono/node-server",
        );
      }
    },
  };
}
