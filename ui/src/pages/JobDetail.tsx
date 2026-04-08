import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { JsonView } from "@/components/JsonView";
import { api } from "@/lib/api";
import { relativeTime, formatDuration, cn } from "@/lib/utils";

const TABS = ["data", "result", "error", "logs", "timeline"] as const;
type Tab = (typeof TABS)[number];

export function JobDetailPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const [tab, setTab] = useState<Tab>("data");
  const queryClient = useQueryClient();

  const { data: job, isLoading } = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => api.getJob(jobId!),
    refetchInterval: 5000,
  });

  const retry = useMutation({
    mutationFn: () => api.retryJob(jobId!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["job", jobId] }),
  });

  const cancel = useMutation({
    mutationFn: () => api.cancelJob(jobId!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["job", jobId] }),
  });

  if (isLoading || !job) {
    return <div className="p-6 text-board-muted">Loading...</div>;
  }

  const duration =
    job.timestamps.finished && job.timestamps.processed
      ? job.timestamps.finished - job.timestamps.processed
      : null;

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <Link
            to={`/tasks/${job.task}`}
            className="text-xs text-board-muted hover:text-board-text"
          >
            &larr; {job.task}
          </Link>
          <div className="flex items-center gap-3 mt-1">
            <h2 className="text-lg font-semibold font-mono">{job.id.slice(0, 12)}...</h2>
            <Badge state={job.state} />
          </div>
        </div>
        <div className="flex gap-2">
          {job.state === "failed" && (
            <Button onClick={() => retry.mutate()} disabled={retry.isPending}>
              Retry
            </Button>
          )}
          {["waiting", "active", "delayed"].includes(job.state) && (
            <Button variant="danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
              Cancel
            </Button>
          )}
        </div>
      </div>

      {/* Meta */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div className="rounded-md border border-board-border bg-board-surface p-3">
          <div className="text-board-muted">Task</div>
          <div className="font-medium mt-0.5">{job.task}</div>
        </div>
        <div className="rounded-md border border-board-border bg-board-surface p-3">
          <div className="text-board-muted">Attempt</div>
          <div className="font-medium mt-0.5">{job.attempt}</div>
        </div>
        <div className="rounded-md border border-board-border bg-board-surface p-3">
          <div className="text-board-muted">Created</div>
          <div className="font-medium mt-0.5">{relativeTime(job.timestamps.created)}</div>
        </div>
        <div className="rounded-md border border-board-border bg-board-surface p-3">
          <div className="text-board-muted">Duration</div>
          <div className="font-medium mt-0.5">{duration ? formatDuration(duration) : "-"}</div>
        </div>
      </div>

      {/* Progress */}
      {job.progress !== null && typeof job.progress === "number" && (
        <div className="rounded-md border border-board-border bg-board-surface p-3">
          <div className="text-xs text-board-muted mb-1">Progress</div>
          <div className="w-full h-2 bg-board-border rounded-full overflow-hidden">
            <div
              className="h-full bg-board-primary rounded-full transition-all"
              style={{ width: `${Math.min(100, job.progress)}%` }}
            />
          </div>
          <div className="text-xs text-board-muted mt-1">{job.progress}%</div>
        </div>
      )}

      {/* Workflow link */}
      {job.workflow && (
        <div className="text-xs">
          <span className="text-board-muted">Part of workflow: </span>
          <Link to={`/workflows/${job.workflow.id}`} className="text-board-primary hover:underline">
            {job.workflow.id.slice(0, 12)}...
          </Link>
          <span className="text-board-muted"> (node {job.workflow.nodeIndex})</span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-board-border">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-3 py-2 text-xs font-medium border-b-2 transition-colors capitalize",
              tab === t
                ? "border-board-primary text-board-primary"
                : "border-transparent text-board-muted hover:text-board-text",
            )}
          >
            {t}
            {t === "logs" && job.logs.length > 0 && (
              <span className="ml-1 text-board-muted">({job.logs.length})</span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="min-h-[200px]">
        {tab === "data" && <JsonView data={job.data} />}
        {tab === "result" && <JsonView data={job.result} />}
        {tab === "error" && (
          <div className="space-y-2">
            {job.error ? (
              <pre className="rounded-md bg-red-500/5 border border-red-500/20 p-3 text-xs text-red-400 whitespace-pre-wrap">
                {job.error}
              </pre>
            ) : (
              <div className="text-board-muted text-sm">No error</div>
            )}
          </div>
        )}
        {tab === "logs" && (
          <div className="space-y-1">
            {job.logs.length === 0 ? (
              <div className="text-board-muted text-sm">No logs</div>
            ) : (
              job.logs.map((log, i) => (
                <div
                  key={i}
                  className={cn(
                    "flex items-start gap-2 text-xs font-mono px-2 py-1 rounded",
                    log.level === "error" && "bg-red-500/5 text-red-400",
                    log.level === "warn" && "bg-amber-500/5 text-amber-400",
                    log.level === "info" && "text-board-text",
                  )}
                >
                  <span className="text-board-muted shrink-0 w-16">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 w-10 uppercase",
                      log.level === "error" && "text-red-400",
                      log.level === "warn" && "text-amber-400",
                      log.level === "info" && "text-board-muted",
                    )}
                  >
                    {log.level}
                  </span>
                  <span className="flex-1">{log.message}</span>
                </div>
              ))
            )}
          </div>
        )}
        {tab === "timeline" && (
          <div className="space-y-2">
            {job.timeline.map((entry, i) => (
              <div key={i} className="flex items-center gap-3 text-xs">
                <Badge state={entry.state} />
                <span className="text-board-muted">{new Date(entry.at).toLocaleString()}</span>
                {i > 0 && (
                  <span className="text-board-muted">
                    (+{formatDuration(entry.at - job.timeline[i - 1].at)})
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
