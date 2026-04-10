import type { Hono } from "hono";
import type { App } from "../app.js";
import type { Duration } from "../scheduler/duration.js";
import type { Taskora } from "../types.js";

export interface BoardAuthUser {
  id: string;
  [key: string]: unknown;
}

export interface BoardAuthConfig {
  cookiePassword: string;
  authenticate: (
    credentials: { username: string; password: string },
    req: Request,
  ) => BoardAuthUser | null | Promise<BoardAuthUser | null>;
  cookieName?: string;
  /**
   * Session lifetime. Default: `"7d"`.
   * Pass `false` to disable expiry — the cookie becomes a browser-session cookie
   * (cleared when the browser closes) and the server never rejects by age.
   */
  sessionTtl?: Duration | false;
}

export type BoardAuthLegacyFn = (
  req: Request,
) => Response | undefined | Promise<Response | undefined>;

export interface BoardOptions {
  basePath?: string;
  readOnly?: boolean;
  auth?: BoardAuthLegacyFn | BoardAuthConfig;
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

export interface Board {
  app: Hono;
  fetch: (req: Request) => Response | Promise<Response>;
  handler: (req: unknown, res: unknown) => void;
  listen: (port: number) => void;
}

export function isBoardAuthConfig(v: BoardOptions["auth"]): v is BoardAuthConfig {
  return (
    typeof v === "object" && v !== null && typeof (v as BoardAuthConfig).authenticate === "function"
  );
}

export interface TaskInfo {
  name: string;
  stats: Taskora.QueueStats;
  config: {
    concurrency: number;
    timeout: number | null;
    retry: { attempts: number; backoff: string } | null;
    version: number;
    since: number;
  };
}

export interface OverviewResponse {
  tasks: TaskInfo[];
  totals: Taskora.QueueStats;
  redis: {
    version: string;
    usedMemory: string;
    uptime: number;
    connected: boolean;
  };
  uptime: number;
}

export interface JobDetailResponse {
  id: string;
  task: string;
  state: Taskora.JobState;
  data: unknown;
  result: unknown | null;
  error: string | null;
  progress: number | Record<string, unknown> | null;
  attempt: number;
  version: number;
  logs: Taskora.LogEntry[];
  timestamps: {
    created: number;
    processed: number | null;
    finished: number | null;
  };
  timeline: Array<{ state: string; at: number }>;
  workflow: { id: string; nodeIndex: number } | null;
}
