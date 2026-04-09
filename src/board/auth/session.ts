import type { Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { parseDuration } from "../../scheduler/duration.js";
import type { BoardAuthConfig, BoardAuthUser } from "../types.js";

const DEFAULT_COOKIE_NAME = "taskora_board_session";

interface SessionPayload {
  user: BoardAuthUser;
  exp: number | null;
}

export function resolveCookieName(cfg: BoardAuthConfig): string {
  return cfg.cookieName ?? DEFAULT_COOKIE_NAME;
}

/**
 * Returns the session lifetime in milliseconds, or `null` when expiry is
 * disabled. Default is disabled — pass `sessionTtl: "7d"` (or any Duration)
 * to opt into a rolling expiry.
 */
export function resolveTtlMs(cfg: BoardAuthConfig): number | null {
  if (cfg.sessionTtl === undefined || cfg.sessionTtl === false) return null;
  return parseDuration(cfg.sessionTtl);
}

function encodePayload(payload: SessionPayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function decodePayload(encoded: string): SessionPayload | null {
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const json = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(json) as SessionPayload;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed.exp !== null && typeof parsed.exp !== "number") ||
      typeof parsed.user !== "object" ||
      parsed.user === null
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function readSession(c: Context, cfg: BoardAuthConfig): Promise<BoardAuthUser | null> {
  const name = resolveCookieName(cfg);
  const raw = await getSignedCookie(c, cfg.cookiePassword, name);
  if (!raw) return null;
  const payload = decodePayload(raw);
  if (!payload) return null;
  if (payload.exp !== null && payload.exp < Date.now()) return null;
  return payload.user;
}

export async function writeSession(
  c: Context,
  cfg: BoardAuthConfig,
  user: BoardAuthUser,
): Promise<void> {
  const ttl = resolveTtlMs(cfg);
  const payload: SessionPayload = {
    user,
    exp: ttl === null ? null : Date.now() + ttl,
  };
  const encoded = encodePayload(payload);
  const secure = new URL(c.req.url).protocol === "https:";
  await setSignedCookie(c, resolveCookieName(cfg), encoded, cfg.cookiePassword, {
    httpOnly: true,
    sameSite: "Lax",
    secure,
    path: "/",
    // When ttl is null: no maxAge → browser-session cookie (cleared on browser close).
    // The server will still accept it indefinitely because exp is null too.
    ...(ttl === null ? {} : { maxAge: Math.floor(ttl / 1000) }),
  });
}

export function clearSession(c: Context, cfg: BoardAuthConfig): void {
  deleteCookie(c, resolveCookieName(cfg), { path: "/" });
}
