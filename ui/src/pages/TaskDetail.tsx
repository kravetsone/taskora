import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { api, type JobDetail } from "@/lib/api";
import { relativeTime, cn, formatNumber } from "@/lib/utils";

const STATES = [
  "waiting",
  "active",
  "delayed",
  "completed",
  "failed",
  "expired",
  "cancelled",
] as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function TaskDetail() {
  const { taskName } = useParams<{ taskName: string }>();
  const [activeState, setActiveState] = useState<string>("waiting");
  const [page, setPage] = useState(0);
  const queryClient = useQueryClient();
  const limit = 20;

  const { data: jobs, isLoading } = useQuery({
    queryKey: ["jobs", taskName, activeState, page],
    queryFn: () => api.getJobs(taskName!, activeState, limit, page * limit),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });

  const { data: taskStats } = useQuery({
    queryKey: ["task-stats", taskName],
    queryFn: () => api.getTaskStats(taskName!),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });

  const { data: throughput } = useQuery({
    queryKey: ["throughput", taskName],
    queryFn: () => api.getThroughput(60000, 60, taskName!),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });

  const retryAll = useMutation({
    mutationFn: () => api.retryAllFailed(taskName!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  });

  const clean = useMutation({
    mutationFn: () => api.cleanJobs(taskName!, activeState),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  });

  if (!taskName) return null;

  const chartData =
    throughput?.map((p) => ({
      time: new Date(p.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      completed: p.completed,
      failed: p.failed,
    })) ?? [];

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <Link to="/" className="text-xs text-board-muted hover:text-board-text">
            &larr; Overview
          </Link>
          <h2 className="text-lg font-semibold mt-1">{taskName}</h2>
        </div>
        <div className="flex gap-2">
          <Link to={`/tasks/${taskName}/migrations`}>
            <Button variant="ghost">Migrations</Button>
          </Link>
          {activeState === "failed" && (
            <Button onClick={() => retryAll.mutate()} disabled={retryAll.isPending}>
              Retry All
            </Button>
          )}
          {["completed", "failed", "expired", "cancelled"].includes(activeState) && (
            <Button variant="ghost" onClick={() => clean.mutate()} disabled={clean.isPending}>
              Clean
            </Button>
          )}
        </div>
      </div>

      {/* Per-task stats */}
      {taskStats && (
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
          <div className="rounded-md border border-board-border bg-board-surface p-3 text-xs">
            <div className="text-board-muted">Redis Keys</div>
            <div className="text-lg font-bold mt-0.5 tabular-nums">{formatNumber(taskStats.keyCount)}</div>
          </div>
          <div className="rounded-md border border-board-border bg-board-surface p-3 text-xs">
            <div className="text-board-muted">Memory</div>
            <div className="text-lg font-bold mt-0.5">{formatBytes(taskStats.memoryBytes)}</div>
          </div>
          <div className="rounded-md border border-board-border bg-board-surface p-3 text-xs">
            <div className="text-board-muted">Active</div>
            <div className="text-lg font-bold mt-0.5 text-cyan-400 tabular-nums">{taskStats.active}</div>
          </div>
          <div className="rounded-md border border-board-border bg-board-surface p-3 text-xs">
            <div className="text-board-muted">Failed</div>
            <div className="text-lg font-bold mt-0.5 text-red-400 tabular-nums">{taskStats.failed}</div>
          </div>
          <div className="rounded-md border border-board-border bg-board-surface p-3 text-xs">
            <div className="text-board-muted">Completed</div>
            <div className="text-lg font-bold mt-0.5 text-emerald-400 tabular-nums">{taskStats.completed}</div>
          </div>
        </div>
      )}

      {/* Per-task throughput chart */}
      {chartData.some((d) => d.completed > 0 || d.failed > 0) && (
        <div className="rounded-lg border border-board-border bg-board-surface p-4">
          <h3 className="text-sm font-medium text-board-muted mb-3">Throughput (last hour)</h3>
          <ResponsiveContainer width="100%" height={150}>
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--board-border)" />
              <XAxis dataKey="time" tick={{ fontSize: 10, fill: "var(--board-text-muted)" }} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10, fill: "var(--board-text-muted)" }} width={30} />
              <Tooltip
                contentStyle={{
                  background: "var(--board-surface)",
                  border: "1px solid var(--board-border)",
                  borderRadius: 6,
                  fontSize: 11,
                }}
              />
              <Area type="monotone" dataKey="completed" stroke="#22c55e" fill="#22c55e" fillOpacity={0.1} strokeWidth={1.5} />
              <Area type="monotone" dataKey="failed" stroke="#ef4444" fill="#ef4444" fillOpacity={0.1} strokeWidth={1.5} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* State tabs */}
      <div className="flex gap-1 border-b border-board-border">
        {STATES.map((state) => (
          <button
            key={state}
            onClick={() => {
              setActiveState(state);
              setPage(0);
            }}
            className={cn(
              "px-3 py-2 text-xs font-medium border-b-2 transition-colors",
              activeState === state
                ? "border-board-primary text-board-primary"
                : "border-transparent text-board-muted hover:text-board-text",
            )}
          >
            {state}
            {taskStats && (
              <span className="ml-1 text-board-muted">
                {taskStats[state as keyof typeof taskStats] ?? ""}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Job table */}
      <div className="rounded-lg border border-board-border bg-board-surface overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-board-border text-board-muted text-xs">
              <th className="text-left px-4 py-2 font-medium">ID</th>
              <th className="text-left px-3 py-2 font-medium">State</th>
              <th className="text-right px-3 py-2 font-medium">Attempt</th>
              <th className="text-right px-3 py-2 font-medium">Created</th>
              <th className="text-right px-4 py-2 font-medium">Error</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && !jobs ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-board-muted">
                  Loading...
                </td>
              </tr>
            ) : !jobs?.length ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-board-muted">
                  No jobs
                </td>
              </tr>
            ) : (
              jobs.map((job) => (
                <tr
                  key={job.id}
                  className="border-b border-board-border/50 hover:bg-board-border/20"
                >
                  <td className="px-4 py-2.5">
                    <Link
                      to={`/jobs/${job.id}`}
                      className="text-board-primary hover:underline font-mono text-xs"
                    >
                      {job.id.slice(0, 8)}...
                    </Link>
                  </td>
                  <td className="px-3 py-2.5">
                    {job.state === "completed" && job.attempt > 1 ? (
                      <span className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium bg-amber-500/20 text-amber-400">
                        completed
                      </span>
                    ) : (
                      <Badge state={job.state} />
                    )}
                  </td>
                  <td className="text-right px-3 py-2.5 tabular-nums text-board-muted">
                    {job.attempt > 1 ? (
                      <span className="text-amber-400">{job.attempt}</span>
                    ) : (
                      job.attempt
                    )}
                  </td>
                  <td className="text-right px-3 py-2.5 text-board-muted text-xs">
                    {relativeTime(job.timestamps.created)}
                  </td>
                  <td className="text-right px-4 py-2.5 text-xs text-red-400 max-w-[200px] truncate">
                    {job.error ?? ""}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {jobs && jobs.length >= limit && (
        <div className="flex gap-2 justify-center">
          <Button variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>
            Prev
          </Button>
          <span className="text-xs text-board-muted py-2">Page {page + 1}</span>
          <Button variant="ghost" onClick={() => setPage(page + 1)}>
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
