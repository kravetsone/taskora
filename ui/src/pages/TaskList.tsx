import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { formatNumber } from "@/lib/utils";

export function TaskList() {
  const { data: overview, isLoading } = useQuery({
    queryKey: ["overview"],
    queryFn: api.getOverview,
    refetchInterval: 5000,
  });

  if (isLoading || !overview) {
    return <div className="p-6 text-board-muted">Loading...</div>;
  }

  return (
    <div className="p-6 space-y-4">
      <h2 className="text-lg font-semibold">Tasks</h2>
      <div className="grid gap-3">
        {overview.tasks.map((task) => (
          <Link
            key={task.name}
            to={`/tasks/${task.name}`}
            className="rounded-lg border border-board-border bg-board-surface p-4 hover:border-board-primary/50 transition-colors"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="font-medium text-board-primary">{task.name}</span>
              <span className="text-xs text-board-muted">v{task.config.version}</span>
            </div>
            <div className="grid grid-cols-4 gap-2 text-xs">
              <div>
                <span className="text-board-muted">Wait: </span>
                <span className="text-blue-400 tabular-nums">
                  {formatNumber(task.stats.waiting)}
                </span>
              </div>
              <div>
                <span className="text-board-muted">Active: </span>
                <span className="text-cyan-400 tabular-nums">
                  {formatNumber(task.stats.active)}
                </span>
              </div>
              <div>
                <span className="text-board-muted">Failed: </span>
                <span className="text-red-400 tabular-nums">{formatNumber(task.stats.failed)}</span>
              </div>
              <div>
                <span className="text-board-muted">Done: </span>
                <span className="text-emerald-400 tabular-nums">
                  {formatNumber(task.stats.completed)}
                </span>
              </div>
            </div>
            <div className="mt-2 text-[10px] text-board-muted">
              concurrency: {task.config.concurrency}
              {task.config.retry &&
                ` | retry: ${task.config.retry.attempts}x ${task.config.retry.backoff}`}
              {task.config.timeout && ` | timeout: ${task.config.timeout}ms`}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
