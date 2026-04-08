import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { App } from "../app.js";
import type { Inspector } from "../inspector.js";
import type { Task } from "../task.js";
import type { Taskora } from "../types.js";
import { createRedactor } from "./redact.js";
import type { BoardOptions, JobDetailResponse, OverviewResponse, TaskInfo } from "./types.js";

export function createApi(app: App, options: BoardOptions = {}): Hono {
  const api = new Hono();
  const readOnly = options.readOnly ?? false;
  const refreshInterval = options.refreshInterval ?? 2000;
  const redact = createRedactor(options.redact);
  const formatData = options.formatters?.data ?? ((d: unknown) => d);
  const formatResult = options.formatters?.result ?? ((r: unknown) => r);
  const startedAt = Date.now();

  if (options.cors) {
    api.use("/*", cors({ origin: options.cors.origin ?? "*" }));
  }

  // Auth middleware
  if (options.auth) {
    const authFn = options.auth;
    api.use("/*", async (c, next) => {
      const result = await authFn(c.req.raw);
      if (result instanceof Response) {
        return result;
      }
      await next();
    });
  }

  // Read-only guard
  if (readOnly) {
    api.use("/*", async (c, next) => {
      if (c.req.method !== "GET") {
        return c.json({ error: "Board is in read-only mode" }, 403);
      }
      await next();
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────

  function getTasks(): IterableIterator<Task<unknown, unknown>> {
    return (
      app as unknown as { getRegisteredTasks(): IterableIterator<Task<unknown, unknown>> }
    ).getRegisteredTasks();
  }

  function getTaskNames(): string[] {
    return [...getTasks()].map((t) => t.name);
  }

  function getTaskMap(): Map<string, Task<unknown, unknown>> {
    const map = new Map<string, Task<unknown, unknown>>();
    for (const t of getTasks()) map.set(t.name, t);
    return map;
  }

  function inspector(): Inspector {
    return app.inspect();
  }

  function safeDeserialize(raw: string | null): unknown {
    if (!raw) return null;
    try {
      return app.serializer.deserialize(raw);
    } catch {
      return raw;
    }
  }

  function formatJob(info: Taskora.JobInfo, taskName: string): JobDetailResponse {
    return {
      id: info.id,
      task: info.task || taskName,
      state: info.state,
      data: redact(formatData(info.data, taskName)),
      result: info.result !== undefined ? redact(formatResult(info.result, taskName)) : null,
      error: info.error ?? null,
      progress: info.progress ?? null,
      attempt: info.attempt,
      version: info.version,
      logs: info.logs,
      timestamps: {
        created: info.timestamp,
        processed: info.processedOn ?? null,
        finished: info.finishedOn ?? null,
      },
      timeline: info.timeline,
      workflow: null, // enriched later if applicable
    };
  }

  // ── Overview ─────────────────────────────────────────────────────

  api.get("/api/overview", async (c) => {
    const taskNames = getTaskNames();
    const taskMap = getTaskMap();
    const taskInfos: TaskInfo[] = [];

    const totals: Taskora.QueueStats = {
      waiting: 0,
      active: 0,
      delayed: 0,
      completed: 0,
      failed: 0,
      expired: 0,
      cancelled: 0,
    };

    const statPromises = taskNames.map((name) => app.adapter.getQueueStats(name));
    const allStats = await Promise.all(statPromises);

    for (let i = 0; i < taskNames.length; i++) {
      const name = taskNames[i];
      const stats = allStats[i];
      const task = taskMap.get(name);

      for (const key of Object.keys(totals) as (keyof Taskora.QueueStats)[]) {
        totals[key] += stats[key];
      }

      taskInfos.push({
        name,
        stats,
        config: {
          concurrency: task?.config.concurrency ?? 1,
          timeout: task?.config.timeout ?? null,
          retry: task?.config.retry
            ? {
                attempts: task.config.retry.attempts,
                backoff:
                  typeof task.config.retry.backoff === "function"
                    ? "custom"
                    : (task.config.retry.backoff ?? "fixed"),
              }
            : null,
          version: task?.version ?? 1,
          since: task?.since ?? 1,
        },
      });
    }

    let redis = { version: "unknown", usedMemory: "0B", uptime: 0, connected: true };
    try {
      redis = await app.adapter.getServerInfo();
    } catch {
      // adapter may not support getServerInfo
    }

    const response: OverviewResponse = {
      tasks: taskInfos,
      totals,
      redis,
      uptime: Date.now() - startedAt,
    };

    return c.json(response);
  });

  // ── Jobs by task ────────────────────────────────────────────────

  api.get("/api/tasks/:task/jobs", async (c) => {
    const taskName = c.req.param("task");
    const state = (c.req.query("state") ?? "waiting") as Taskora.JobState;
    const limit = Number(c.req.query("limit") ?? 20);
    const offset = Number(c.req.query("offset") ?? 0);

    const insp = inspector();
    const method = {
      waiting: "waiting",
      active: "active",
      delayed: "delayed",
      completed: "completed",
      failed: "failed",
      expired: "expired",
      cancelled: "cancelled",
      retrying: "delayed",
    } as const;

    const fn = method[state] ?? "waiting";
    const jobs = await (
      insp as unknown as Record<
        string,
        (opts: Taskora.InspectorListOptions) => Promise<Taskora.JobInfo[]>
      >
    )[fn]({
      task: taskName,
      limit,
      offset,
    });

    return c.json(jobs.map((j) => formatJob(j, taskName)));
  });

  // ── Job detail ──────────────────────────────────────────────────

  api.get("/api/jobs/:jobId", async (c) => {
    const jobId = c.req.param("jobId");
    const insp = inspector();
    const job = await insp.find(jobId);
    if (!job) return c.json({ error: "Job not found" }, 404);

    const detail = formatJob(job, job.task);

    // Enrich with workflow info
    try {
      const wfMeta = await app.adapter.getWorkflowMeta(job.task, jobId);
      if (wfMeta) {
        detail.workflow = { id: wfMeta.workflowId, nodeIndex: wfMeta.nodeIndex };
      }
    } catch {
      // ignore
    }

    return c.json(detail);
  });

  // ── Job actions ─────────────────────────────────────────────────

  api.post("/api/jobs/:jobId/retry", async (c) => {
    const jobId = c.req.param("jobId");
    const taskNames = getTaskNames();

    for (const task of taskNames) {
      const result = await app.adapter.retryFromDLQ(task, jobId);
      if (result) return c.json({ ok: true });
    }

    return c.json({ error: "Job not found in DLQ" }, 404);
  });

  api.post("/api/jobs/:jobId/cancel", async (c) => {
    const jobId = c.req.param("jobId");
    const body = await c.req.json().catch(() => ({}));
    const taskNames = getTaskNames();

    for (const task of taskNames) {
      const state = await app.adapter.getState(task, jobId);
      if (state) {
        const result = await app.adapter.cancel(task, jobId, (body as { reason?: string }).reason);
        return c.json({ ok: true, result });
      }
    }

    return c.json({ error: "Job not found" }, 404);
  });

  api.post("/api/tasks/:task/retry-all", async (c) => {
    const taskName = c.req.param("task");
    const count = await app.adapter.retryAllFromDLQ(taskName, 1000);
    return c.json({ ok: true, count });
  });

  api.post("/api/tasks/:task/clean", async (c) => {
    const taskName = c.req.param("task");
    const state = (c.req.query("state") ?? "completed") as Taskora.JobState;
    const before = Number(c.req.query("before") ?? Date.now());
    const count = await app.adapter.cleanJobs(taskName, state, before, 1000);
    return c.json({ ok: true, count });
  });

  // ── Schedules ───────────────────────────────────────────────────

  api.get("/api/schedules", async (c) => {
    const schedules = await app.schedules.list();
    return c.json(schedules);
  });

  api.post("/api/schedules/:name/pause", async (c) => {
    const name = c.req.param("name");
    await app.schedules.pause(name);
    return c.json({ ok: true });
  });

  api.post("/api/schedules/:name/resume", async (c) => {
    const name = c.req.param("name");
    await app.schedules.resume(name);
    return c.json({ ok: true });
  });

  api.post("/api/schedules/:name/trigger", async (c) => {
    const name = c.req.param("name");
    const handle = await app.schedules.trigger(name);
    const id = await handle;
    return c.json({ ok: true, jobId: id });
  });

  api.put("/api/schedules/:name", async (c) => {
    const name = c.req.param("name");
    const updates = await c.req.json();
    await app.schedules.update(name, updates);
    return c.json({ ok: true });
  });

  api.delete("/api/schedules/:name", async (c) => {
    const name = c.req.param("name");
    await app.schedules.remove(name);
    return c.json({ ok: true });
  });

  // ── Workflows ───────────────────────────────────────────────────

  api.get("/api/workflows", async (c) => {
    const state = c.req.query("state") as Taskora.WorkflowState | undefined;
    const limit = Number(c.req.query("limit") ?? 20);
    const offset = Number(c.req.query("offset") ?? 0);

    const workflows = await app.adapter.listWorkflows(state, offset, limit);
    return c.json(workflows);
  });

  api.get("/api/workflows/:workflowId", async (c) => {
    const workflowId = c.req.param("workflowId");
    const detail = await app.adapter.getWorkflowDetail(workflowId);
    if (!detail) return c.json({ error: "Workflow not found" }, 404);
    return c.json(detail);
  });

  api.post("/api/workflows/:workflowId/cancel", async (c) => {
    const workflowId = c.req.param("workflowId");
    const body = await c.req.json().catch(() => ({}));
    const result = await app.adapter.cancelWorkflow(
      workflowId,
      (body as { reason?: string }).reason,
    );

    // Cancel active jobs
    for (const { task, jobId } of result.activeJobIds) {
      await app.adapter.cancel(task, jobId, (body as { reason?: string }).reason);
    }

    return c.json({ ok: true });
  });

  // ── DLQ ─────────────────────────────────────────────────────────

  api.get("/api/dlq", async (c) => {
    const taskFilter = c.req.query("task");
    const limit = Number(c.req.query("limit") ?? 20);
    const offset = Number(c.req.query("offset") ?? 0);

    const insp = inspector();
    const jobs = await insp.failed({ task: taskFilter, limit, offset });
    return c.json(jobs.map((j) => formatJob(j, j.task)));
  });

  api.post("/api/dlq/:jobId/retry", async (c) => {
    const jobId = c.req.param("jobId");
    const taskNames = getTaskNames();

    for (const task of taskNames) {
      const result = await app.adapter.retryFromDLQ(task, jobId);
      if (result) return c.json({ ok: true });
    }

    return c.json({ error: "Job not found in DLQ" }, 404);
  });

  api.post("/api/dlq/retry-all", async (c) => {
    const taskFilter = c.req.query("task");
    let total = 0;

    if (taskFilter) {
      total = await app.adapter.retryAllFromDLQ(taskFilter, 1000);
    } else {
      for (const name of getTaskNames()) {
        total += await app.adapter.retryAllFromDLQ(name, 1000);
      }
    }

    return c.json({ ok: true, count: total });
  });

  // ── Migrations ──────────────────────────────────────────────────

  api.get("/api/tasks/:task/migrations", async (c) => {
    const taskName = c.req.param("task");
    const insp = inspector();
    const status = await insp.migrations(taskName);
    return c.json(status);
  });

  // ── Throughput ──────────────────────────────────────────────────

  api.get("/api/throughput", async (c) => {
    const taskFilter = c.req.query("task") ?? null;
    const bucketSize = Number(c.req.query("bucket") ?? 60000);
    const count = Number(c.req.query("count") ?? 60);

    const data = await app.adapter.getThroughput(taskFilter, bucketSize, count);
    return c.json(data);
  });

  // ── SSE ─────────────────────────────────────────────────────────

  api.get("/api/events", async (c) => {
    const taskFilter = c.req.query("tasks")?.split(",").filter(Boolean);
    const taskNames = taskFilter?.length ? taskFilter : getTaskNames();

    return streamSSE(c, async (stream) => {
      let unsubscribe: (() => Promise<void>) | null = null;

      try {
        unsubscribe = await app.adapter.subscribe(taskNames, (event) => {
          stream.writeSSE({
            event: `job:${event.event}`,
            data: JSON.stringify({
              id: event.jobId,
              task: event.task,
              ...event.fields,
            }),
          });
        });

        // Periodic stats update
        const statsInterval = setInterval(async () => {
          try {
            const statsPromises = taskNames.map((name) => app.adapter.getQueueStats(name));
            const allStats = await Promise.all(statsPromises);

            for (let i = 0; i < taskNames.length; i++) {
              await stream.writeSSE({
                event: "stats:update",
                data: JSON.stringify({
                  task: taskNames[i],
                  stats: allStats[i],
                }),
              });
            }
          } catch {
            // ignore stats errors
          }
        }, refreshInterval);

        // Keep connection alive with heartbeat
        const heartbeat = setInterval(() => {
          stream.writeSSE({ event: "heartbeat", data: "" });
        }, 15000);

        // Wait until client disconnects
        await new Promise<void>((resolve) => {
          stream.onAbort(() => {
            clearInterval(statsInterval);
            clearInterval(heartbeat);
            resolve();
          });
        });
      } finally {
        if (unsubscribe) {
          await unsubscribe().catch(() => {});
        }
      }
    });
  });

  // ── Board config ────────────────────────────────────────────────

  api.get("/api/config", (c) => {
    return c.json({
      title: options.title ?? "taskora board",
      logo: options.logo ?? null,
      favicon: options.favicon ?? null,
      theme: options.theme ?? "auto",
      readOnly,
      refreshInterval,
    });
  });

  return api;
}
