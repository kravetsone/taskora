import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBoard } from "../../src/board/index.js";
import type { Board } from "../../src/board/index.js";
import { createTaskora } from "../../src/index.js";
import { memoryAdapter } from "../../src/memory/index.js";

const COOKIE_PASSWORD = "x".repeat(48);

// The board's static SPA is gitignored (`src/board/static/` is built by
// `bun run build:ui` or the publish workflow). These tests exercise the SPA
// redirect/guard path, which requires the static handler to be registered —
// which requires `src/board/static/index.html` to exist. Seed a minimal stub
// so the tests work in CI (where the build hasn't run yet) and locally.
beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const staticDir = resolve(here, "../../src/board/static");
  const indexHtml = resolve(staticDir, "index.html");
  if (!existsSync(indexHtml)) {
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(
      indexHtml,
      "<!doctype html><html><head><title>taskora board (test stub)</title></head><body><div id=\"root\"></div></body></html>",
    );
  }
});

function makeApp() {
  return createTaskora({ adapter: memoryAdapter() });
}

function makeBoardWithSessionAuth(
  overrides: Partial<Parameters<typeof createBoard>[1]> = {},
): Board {
  const app = makeApp();
  return createBoard(app, {
    auth: {
      cookiePassword: COOKIE_PASSWORD,
      authenticate: async ({ username, password }) =>
        username === "admin" && password === "secret" ? { id: "admin" } : null,
    },
    ...overrides,
  });
}

function formBody(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function postForm(path: string, fields: Record<string, string>, cookie?: string): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (cookie) headers.Cookie = cookie;
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: formBody(fields),
    redirect: "manual",
  });
}

function get(path: string, cookie?: string): Request {
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  return new Request(`http://localhost${path}`, {
    method: "GET",
    headers,
    redirect: "manual",
  });
}

function extractSessionCookie(res: Response): string {
  const setCookie = res.headers.get("Set-Cookie");
  if (!setCookie) throw new Error("no Set-Cookie header");
  // Just keep the name=value portion (strip the attributes)
  const firstPart = setCookie.split(";")[0];
  return firstPart;
}

describe("board auth — session config", () => {
  let board: Board;

  beforeEach(() => {
    board = makeBoardWithSessionAuth();
  });

  it("POST /auth/login with valid creds sets session cookie and redirects", async () => {
    const res = await board.fetch(
      postForm("/board/auth/login", { username: "admin", password: "secret" }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/board");
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain("taskora_board_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("POST /auth/login with wrong creds returns 401 HTML with error", async () => {
    const res = await board.fetch(
      postForm("/board/auth/login", { username: "admin", password: "nope" }),
    );
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain("Invalid credentials");
    expect(body).toContain("<form");
  });

  it("GET /api/overview without cookie returns 401 JSON", async () => {
    const res = await board.fetch(get("/board/api/overview"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("GET /api/overview with valid cookie returns 200", async () => {
    const loginRes = await board.fetch(
      postForm("/board/auth/login", { username: "admin", password: "secret" }),
    );
    const cookie = extractSessionCookie(loginRes);

    const res = await board.fetch(get("/board/api/overview", cookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: unknown[] };
    expect(Array.isArray(body.tasks)).toBe(true);
  });

  it("GET /board/ without cookie redirects to /board/login", async () => {
    const res = await board.fetch(get("/board/"));
    expect(res.status).toBe(302);
    const location = res.headers.get("Location");
    expect(location).toContain("/board/login");
    expect(location).toContain("redirect=");
  });

  it("GET /board/login is unguarded and renders the form", async () => {
    const res = await board.fetch(get("/board/login"));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('name="username"');
    expect(body).toContain('name="password"');
    expect(body).toContain('action="/board/auth/login"');
  });

  it("POST /auth/logout clears the session cookie", async () => {
    const loginRes = await board.fetch(
      postForm("/board/auth/login", { username: "admin", password: "secret" }),
    );
    const cookie = extractSessionCookie(loginRes);

    const res = await board.fetch(postForm("/board/auth/logout", {}, cookie));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/board/login");
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain("taskora_board_session=");
    // deleteCookie sets MaxAge=0 or an expired date
    expect(setCookie?.toLowerCase()).toMatch(/max-age=0|expires=/);
  });

  it("default sessionTtl is disabled — cookie has no Max-Age and never expires", async () => {
    const res = await board.fetch(
      postForm("/board/auth/login", { username: "admin", password: "secret" }),
    );
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).toBeTruthy();
    // No Max-Age → browser-session cookie
    expect(setCookie?.toLowerCase()).not.toContain("max-age");
  });

  it("expired session is rejected on API and SPA", async () => {
    const shortBoard = createBoard(makeApp(), {
      auth: {
        cookiePassword: COOKIE_PASSWORD,
        sessionTtl: 50, // 50ms
        authenticate: async ({ username, password }) =>
          username === "admin" && password === "secret" ? { id: "admin" } : null,
      },
    });
    const loginRes = await shortBoard.fetch(
      postForm("/board/auth/login", { username: "admin", password: "secret" }),
    );
    const cookie = extractSessionCookie(loginRes);

    // wait until exp elapses
    await new Promise((r) => setTimeout(r, 80));

    const apiRes = await shortBoard.fetch(get("/board/api/overview", cookie));
    expect(apiRes.status).toBe(401);

    const spaRes = await shortBoard.fetch(get("/board/", cookie));
    expect(spaRes.status).toBe(302);
    expect(spaRes.headers.get("Location")).toContain("/board/login");
  });

  it("throws if cookiePassword is shorter than 32 chars", () => {
    expect(() =>
      createBoard(makeApp(), {
        auth: {
          cookiePassword: "too-short",
          authenticate: async () => ({ id: "x" }),
        },
      }),
    ).toThrow(/cookiePassword must be at least 32 characters/);
  });

  it("ignores open-redirect attempts in the redirect query field", async () => {
    const res = await board.fetch(
      postForm("/board/auth/login", {
        username: "admin",
        password: "secret",
        redirect: "https://evil.example.com/pwn",
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/board");
  });

  it("preserves valid in-basePath redirect target", async () => {
    const res = await board.fetch(
      postForm("/board/auth/login", {
        username: "admin",
        password: "secret",
        redirect: "/board/tasks",
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/board/tasks");
  });

  it("/api/config advertises authEnabled: true", async () => {
    const loginRes = await board.fetch(
      postForm("/board/auth/login", { username: "admin", password: "secret" }),
    );
    const cookie = extractSessionCookie(loginRes);

    const res = await board.fetch(get("/board/api/config", cookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authEnabled: boolean };
    expect(body.authEnabled).toBe(true);
  });
});

describe("board auth — legacy function hook", () => {
  it("guards API but leaves SPA HTML unguarded (backward compat)", async () => {
    const app = makeApp();
    const board = createBoard(app, {
      auth: (req) => {
        if (req.headers.get("x-key") !== "k") {
          return new Response("Unauthorized", { status: 401 });
        }
        return undefined;
      },
    });

    // API rejected without key
    const apiNoKey = await board.fetch(get("/board/api/overview"));
    expect(apiNoKey.status).toBe(401);

    // API accepted with key
    const apiWithKey = await board.fetch(
      new Request("http://localhost/board/api/overview", { headers: { "x-key": "k" } }),
    );
    expect(apiWithKey.status).toBe(200);

    // SPA HTML remains public (current behavior)
    const spa = await board.fetch(get("/board/"));
    expect(spa.status).toBe(200);
    const html = await spa.text();
    expect(html).toContain("<html");
  });

  it("/api/config reports authEnabled: false for legacy hook", async () => {
    const app = makeApp();
    const board = createBoard(app, {
      auth: () => undefined,
    });
    const res = await board.fetch(get("/board/api/config"));
    const body = (await res.json()) as { authEnabled: boolean };
    expect(body.authEnabled).toBe(false);
  });
});
