import { Hono } from "hono";
import type { BoardAuthConfig, BoardOptions } from "../types.js";
import { renderLoginPage } from "./login-page.js";
import { clearSession, writeSession } from "./session.js";

function safeRedirect(raw: string | undefined, basePath: string): string {
  if (!raw) return basePath;
  if (raw.includes("//") || raw.includes("\\")) return basePath;
  if (!raw.startsWith(basePath)) return basePath;
  return raw;
}

function coerceField(value: unknown): string {
  if (typeof value === "string") return value;
  return "";
}

export function createAuthRoutes(
  cfg: BoardAuthConfig,
  options: BoardOptions,
  basePath: string,
): Hono {
  const router = new Hono();
  const title = options.title ?? "taskora board";

  router.get("/login", (c) => {
    const redirect = c.req.query("redirect");
    return c.html(
      renderLoginPage({
        title,
        basePath,
        redirect: redirect ? safeRedirect(redirect, basePath) : undefined,
      }),
    );
  });

  router.post("/auth/login", async (c) => {
    const body = await c.req.parseBody();
    const username = coerceField(body.username);
    const password = coerceField(body.password);
    const redirect = coerceField(body.redirect);

    if (!username || !password) {
      return c.html(
        renderLoginPage({
          title,
          basePath,
          error: "Username and password are required",
          redirect,
          username,
        }),
        401,
      );
    }

    let user = null;
    try {
      user = await cfg.authenticate({ username, password }, c.req.raw);
    } catch {
      user = null;
    }

    if (!user) {
      return c.html(
        renderLoginPage({
          title,
          basePath,
          error: "Invalid credentials",
          redirect,
          username,
        }),
        401,
      );
    }

    await writeSession(c, cfg, user);
    return c.redirect(safeRedirect(redirect, basePath));
  });

  router.post("/auth/logout", (c) => {
    clearSession(c, cfg);
    return c.redirect(`${basePath}/login`);
  });

  return router;
}
