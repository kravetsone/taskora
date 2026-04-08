import type { Hono } from "hono";
import type { App } from "../app.js";
import type { Taskora } from "../types.js";

export interface BoardOptions {
  basePath?: string;
  readOnly?: boolean;
  auth?: (req: Request) => Response | void | Promise<Response | void>;
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
