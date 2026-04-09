import type { MiddlewareHandler } from "hono";
import type { BoardAuthConfig } from "../types.js";
import { readSession } from "./session.js";

export type GuardMode = "api" | "html";

function isAuthRoutePath(path: string, basePath: string): boolean {
  if (path === `${basePath}/login`) return true;
  if (path === `${basePath}/auth/login`) return true;
  if (path === `${basePath}/auth/logout`) return true;
  return false;
}

export function createAuthGuard(
  cfg: BoardAuthConfig,
  basePath: string,
  mode: GuardMode,
): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    if (isAuthRoutePath(path, basePath)) {
      return next();
    }

    const user = await readSession(c, cfg);
    if (user) {
      c.set("boardUser", user);
      return next();
    }

    if (mode === "api") {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const redirect = encodeURIComponent(path);
    return c.redirect(`${basePath}/login?redirect=${redirect}`);
  };
}
