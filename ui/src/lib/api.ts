// Derive base path from the current page URL so API calls always hit /board/api/...
// In dev mode, Vite proxy handles /board/api → backend
// In production, SPA is served under /board/ so we strip to get the mount point
function getBase(): string {
  if (import.meta.env.DEV) return "/board";
  // window.location.pathname might be /board/jobs/abc — we need /board
  const path = window.location.pathname;
  const segments = path.split("/").filter(Boolean);
  // The first segment is the basePath (e.g. "board")
  return segments.length > 0 ? `/${segments[0]}` : "";
}

const BASE = getBase();

async function fetchApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Types ────────────────────────────────────────────────────────

export interface QueueStats {
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
  expired: number;
  cancelled: number;
}

export interface TaskInfo {
  name: string;
  stats: QueueStats;
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
  totals: QueueStats;
  redis: {
    version: string;
    usedMemory: string;
    usedMemoryBytes?: number;
    peakMemory?: string;
    uptime: number;
    connected: boolean;
    dbSize?: number;
    connectedClients?: number;
  };
  uptime: number;
}

export interface JobDetail {
  id: string;
  task: string;
  state: string;
  data: unknown;
  result: unknown;
  error: string | null;
  progress: number | Record<string, unknown> | null;
  attempt: number;
  version: number;
  logs: Array<{
    level: string;
    message: string;
    meta?: Record<string, unknown>;
    timestamp: number;
  }>;
  timestamps: { created: number; processed: number | null; finished: number | null };
  timeline: Array<{ state: string; at: number }>;
  workflow: { id: string; nodeIndex: number } | null;
}

export interface ScheduleInfo {
  name: string;
  config: {
    task: string;
    every?: string | number;
    cron?: string;
    timezone?: string;
    onMissed?: string;
    overlap?: boolean;
    data?: unknown;
  };
  nextRun: number | null;
  lastRun: number | null;
  lastJobId: string | null;
  paused: boolean;
}

export interface WorkflowSummary {
  id: string;
  state: string;
  createdAt: number;
  nodeCount: number;
  name: string | null;
  tasks: string[];
}

export interface WorkflowDetail {
  id: string;
  state: string;
  createdAt: number;
  graph: {
    nodes: Array<{ taskName: string; data?: string; deps: number[]; jobId: string; _v: number }>;
    terminal: number[];
    name?: string;
  };
  nodes: Array<{
    index: number;
    state: string;
    result: string | null;
    error: string | null;
    jobId: string;
  }>;
  result: string | null;
  error: string | null;
}

export interface ThroughputPoint {
  timestamp: number;
  completed: number;
  failed: number;
}

export interface MigrationStatus {
  version: number;
  since: number;
  migrations: number;
  canBumpSince: number;
  queue: { oldest: number | null; byVersion: Record<number, number> };
  delayed: { oldest: number | null; byVersion: Record<number, number> };
}

export interface BoardConfig {
  title: string;
  logo: string | null;
  favicon: string | null;
  theme: "light" | "dark" | "auto";
  readOnly: boolean;
  refreshInterval: number;
  authEnabled: boolean;
}

// ── API functions ────────────────────────────────────────────────

export const api = {
  getOverview: () => fetchApi<OverviewResponse>("/api/overview"),
  getConfig: () => fetchApi<BoardConfig>("/api/config"),

  // Jobs
  getJobs: (task: string, state: string, limit = 20, offset = 0) =>
    fetchApi<JobDetail[]>(`/api/tasks/${task}/jobs?state=${state}&limit=${limit}&offset=${offset}`),
  getJob: (jobId: string) => fetchApi<JobDetail>(`/api/jobs/${jobId}`),
  retryJob: (jobId: string) =>
    fetchApi<{ ok: boolean }>(`/api/jobs/${jobId}/retry`, { method: "POST" }),
  cancelJob: (jobId: string, reason?: string) =>
    fetchApi<{ ok: boolean }>(`/api/jobs/${jobId}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  retryAllFailed: (task: string) =>
    fetchApi<{ ok: boolean; count: number }>(`/api/tasks/${task}/retry-all`, { method: "POST" }),
  cleanJobs: (task: string, state: string) =>
    fetchApi<{ ok: boolean; count: number }>(`/api/tasks/${task}/clean?state=${state}`, {
      method: "POST",
    }),

  // Schedules
  getSchedules: () => fetchApi<ScheduleInfo[]>("/api/schedules"),
  pauseSchedule: (name: string) =>
    fetchApi<{ ok: boolean }>(`/api/schedules/${name}/pause`, { method: "POST" }),
  resumeSchedule: (name: string) =>
    fetchApi<{ ok: boolean }>(`/api/schedules/${name}/resume`, { method: "POST" }),
  triggerSchedule: (name: string) =>
    fetchApi<{ ok: boolean }>(`/api/schedules/${name}/trigger`, { method: "POST" }),
  deleteSchedule: (name: string) =>
    fetchApi<{ ok: boolean }>(`/api/schedules/${name}`, { method: "DELETE" }),

  // Workflows
  getWorkflows: (state?: string, limit = 20, offset = 0) =>
    fetchApi<WorkflowSummary[]>(
      `/api/workflows?${state ? `state=${state}&` : ""}limit=${limit}&offset=${offset}`,
    ),
  getWorkflow: (id: string) => fetchApi<WorkflowDetail>(`/api/workflows/${id}`),
  cancelWorkflow: (id: string, reason?: string) =>
    fetchApi<{ ok: boolean }>(`/api/workflows/${id}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  // DLQ
  getDlq: (task?: string, limit = 20, offset = 0) =>
    fetchApi<JobDetail[]>(`/api/dlq?${task ? `task=${task}&` : ""}limit=${limit}&offset=${offset}`),
  retryDlqJob: (jobId: string) =>
    fetchApi<{ ok: boolean }>(`/api/dlq/${jobId}/retry`, { method: "POST" }),
  retryAllDlq: (task?: string) =>
    fetchApi<{ ok: boolean; count: number }>(`/api/dlq/retry-all${task ? `?task=${task}` : ""}`, {
      method: "POST",
    }),

  // Migrations
  getMigrations: (task: string) => fetchApi<MigrationStatus>(`/api/tasks/${task}/migrations`),

  // Task stats (keys + memory)
  getTaskStats: (task: string) =>
    fetchApi<QueueStats & { keyCount: number; memoryBytes: number }>(`/api/tasks/${task}/stats`),

  // Throughput
  getThroughput: (bucket = 60000, count = 60, task?: string) =>
    fetchApi<ThroughputPoint[]>(
      `/api/throughput?bucket=${bucket}&count=${count}${task ? `&task=${task}` : ""}`,
    ),

  // SSE
  createEventSource: (tasks?: string[]): EventSource => {
    const params = tasks?.length ? `?tasks=${tasks.join(",")}` : "";
    return new EventSource(`${BASE}/api/events${params}`);
  },
};
