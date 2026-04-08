import { readFileSync, existsSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { Hono } from "hono";
import type { App } from "../app.js";
import { createApi } from "./api.js";
import type { Board, BoardOptions } from "./types.js";

export type { Board, BoardOptions } from "./types.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function findStaticDir(): string | null {
  // Try multiple locations: source (dev), dist (published)
  const candidates = [
    resolve(import.meta.dir ?? ".", "static"),
    resolve(import.meta.dir ?? ".", "../board/static"),
    resolve(process.cwd(), "src/board/static"),
    resolve(process.cwd(), "dist/board/static"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  return null;
}

export function createBoard(app: App, options: BoardOptions = {}): Board {
  const basePath = options.basePath ?? "/board";
  const root = new Hono();
  const api = createApi(app, options);
  const staticDir = findStaticDir();

  // Mount API under basePath
  root.route(basePath, api);

  // Serve static files
  if (staticDir) {
    const indexHtml = readFileSync(join(staticDir, "index.html"), "utf-8");

    root.get(`${basePath}/*`, (c) => {
      // Strip basePath prefix to get the relative file path
      const url = new URL(c.req.url);
      let filePath = url.pathname.slice(basePath.length) || "/";
      if (filePath === "/") filePath = "/index.html";

      const fullPath = join(staticDir, filePath);

      // Security: prevent path traversal
      if (!fullPath.startsWith(staticDir)) {
        return c.text("Forbidden", 403);
      }

      if (existsSync(fullPath)) {
        const content = readFileSync(fullPath);
        const mime = MIME_TYPES[extname(filePath)] ?? "application/octet-stream";
        return new Response(content, {
          headers: { "Content-Type": mime, "Cache-Control": "public, max-age=31536000, immutable" },
        });
      }

      // SPA fallback: serve index.html for all non-file routes
      return new Response(indexHtml, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    });
  }

  const honoFetch = root.fetch.bind(root);

  return {
    app: root,
    fetch: honoFetch,
    handler: (_req: unknown, _res: unknown) => {
      throw new Error(
        "Use board.fetch for Web standard servers (Bun/Deno) or @hono/node-server for Express/Koa",
      );
    },
    listen: (port: number) => {
      const g = globalThis as Record<string, unknown>;
      if (typeof g.Bun !== "undefined") {
        (g.Bun as { serve: (opts: unknown) => void }).serve({ fetch: honoFetch, port });
        console.log(`taskora board listening on http://localhost:${port}${basePath}`);
      } else if (typeof g.Deno !== "undefined") {
        (g.Deno as { serve: (opts: unknown, handler: unknown) => void }).serve(
          { port },
          honoFetch,
        );
        console.log(`taskora board listening on http://localhost:${port}${basePath}`);
      } else {
        throw new Error(
          "board.listen() requires Bun or Deno. For Node.js, use board.fetch with @hono/node-server",
        );
      }
    },
  };
}
