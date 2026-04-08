import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { api, type JobDetail } from "@/lib/api";
import { relativeTime, cn } from "@/lib/utils";

const STATES = [
  "waiting",
  "active",
  "delayed",
  "completed",
  "failed",
  "expired",
  "cancelled",
] as const;

export function TaskDetail() {
  const { taskName } = useParams<{ taskName: string }>();
  const [activeState, setActiveState] = useState<string>("waiting");
  const [page, setPage] = useState(0);
  const queryClient = useQueryClient();
  const limit = 20;

  const { data: jobs, isLoading } = useQuery({
    queryKey: ["jobs", taskName, activeState, page],
    queryFn: () => api.getJobs(taskName!, activeState, limit, page * limit),
    refetchInterval: 5000,
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
            {isLoading ? (
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
                    <Badge state={job.state} />
                  </td>
                  <td className="text-right px-3 py-2.5 tabular-nums text-board-muted">
                    {job.attempt}
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
