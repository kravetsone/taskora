import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/utils";

export function DLQ() {
  const [taskFilter, setTaskFilter] = useState<string | undefined>(undefined);
  const queryClient = useQueryClient();

  const { data: overview } = useQuery({
    queryKey: ["overview"],
    queryFn: api.getOverview,
  });

  const { data: jobs, isLoading } = useQuery({
    queryKey: ["dlq", taskFilter],
    queryFn: () => api.getDlq(taskFilter, 50),
    refetchInterval: 5000,
  });

  const retryJob = useMutation({
    mutationFn: (jobId: string) => api.retryDlqJob(jobId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dlq"] }),
  });

  const retryAll = useMutation({
    mutationFn: () => api.retryAllDlq(taskFilter),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dlq"] }),
  });

  // Group errors for frequency display
  const errorGroups = new Map<string, number>();
  if (jobs) {
    for (const job of jobs) {
      const key = job.error ?? "Unknown error";
      const short = key.length > 80 ? key.slice(0, 80) + "..." : key;
      errorGroups.set(short, (errorGroups.get(short) ?? 0) + 1);
    }
  }

  const taskNames = overview?.tasks.map((t) => t.name) ?? [];

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Dead Letter Queue</h2>
        <div className="flex gap-2">
          <select
            className="text-xs bg-board-surface border border-board-border rounded-md px-2 py-1.5 text-board-text"
            value={taskFilter ?? ""}
            onChange={(e) => setTaskFilter(e.target.value || undefined)}
          >
            <option value="">All tasks</option>
            {taskNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <Button onClick={() => retryAll.mutate()} disabled={retryAll.isPending || !jobs?.length}>
            Retry All ({jobs?.length ?? 0})
          </Button>
        </div>
      </div>

      {/* Error frequency */}
      {errorGroups.size > 0 && (
        <div className="rounded-lg border border-board-border bg-board-surface p-4 space-y-2">
          <h3 className="text-xs font-medium text-board-muted">Error Frequency</h3>
          {[...errorGroups.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([error, count]) => (
              <div key={error} className="flex items-center gap-2 text-xs">
                <span className="bg-red-500/20 text-red-400 rounded px-1.5 py-0.5 tabular-nums font-medium">
                  {count}
                </span>
                <span className="text-board-muted truncate">{error}</span>
              </div>
            ))}
        </div>
      )}

      {/* Job table */}
      <div className="rounded-lg border border-board-border bg-board-surface overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-board-border text-board-muted text-xs">
              <th className="text-left px-4 py-2 font-medium">ID</th>
              <th className="text-left px-3 py-2 font-medium">Task</th>
              <th className="text-right px-3 py-2 font-medium">Attempts</th>
              <th className="text-left px-3 py-2 font-medium">Error</th>
              <th className="text-right px-3 py-2 font-medium">Failed</th>
              <th className="text-right px-4 py-2 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-board-muted">
                  Loading...
                </td>
              </tr>
            ) : !jobs?.length ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-board-muted">
                  DLQ is empty
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
                  <td className="px-3 py-2.5 text-board-muted">{job.task}</td>
                  <td className="text-right px-3 py-2.5 tabular-nums text-board-muted">
                    {job.attempt}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-red-400 max-w-[250px] truncate">
                    {job.error ?? "Unknown"}
                  </td>
                  <td className="text-right px-3 py-2.5 text-xs text-board-muted">
                    {job.timestamps.finished ? relativeTime(job.timestamps.finished) : "-"}
                  </td>
                  <td className="text-right px-4 py-2.5">
                    <Button
                      size="sm"
                      onClick={() => retryJob.mutate(job.id)}
                      disabled={retryJob.isPending}
                    >
                      Retry
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
