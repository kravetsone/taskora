import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { Badge } from "@/components/Badge";
import { api } from "@/lib/api";
import { relativeTime, cn } from "@/lib/utils";

const FILTERS = [undefined, "running", "completed", "failed", "cancelled"] as const;

export function WorkflowList() {
  const [filter, setFilter] = useState<string | undefined>(undefined);

  const { data: workflows, isLoading } = useQuery({
    queryKey: ["workflows", filter],
    queryFn: () => api.getWorkflows(filter, 50),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });

  return (
    <div className="p-6 space-y-4">
      <h2 className="text-lg font-semibold">Workflows</h2>

      <div className="flex gap-1 border-b border-board-border">
        {FILTERS.map((f) => (
          <button
            key={f ?? "all"}
            onClick={() => setFilter(f)}
            className={cn(
              "px-3 py-2 text-xs font-medium border-b-2 transition-colors capitalize",
              filter === f
                ? "border-board-primary text-board-primary"
                : "border-transparent text-board-muted hover:text-board-text",
            )}
          >
            {f ?? "all"}
          </button>
        ))}
      </div>

      {isLoading && !workflows ? (
        <div className="text-board-muted text-sm">Loading...</div>
      ) : !workflows?.length ? (
        <div className="text-board-muted text-sm">No workflows</div>
      ) : (
        <div className="space-y-2">
          {workflows.map((wf) => (
            <Link
              key={wf.id}
              to={`/workflows/${wf.id}`}
              className="block rounded-lg border border-board-border bg-board-surface p-4 hover:border-board-primary/50 transition-colors"
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2 min-w-0">
                  {wf.name ? (
                    <span className="font-medium text-sm text-board-text truncate">{wf.name}</span>
                  ) : (
                    <span className="font-mono text-xs text-board-primary">{wf.id.slice(0, 12)}...</span>
                  )}
                  <Badge state={wf.state} />
                  <span className="text-xs text-board-muted shrink-0">{wf.nodeCount} nodes</span>
                </div>
                <span className="text-xs text-board-muted shrink-0">{relativeTime(wf.createdAt)}</span>
              </div>

              {/* Task flow visualization */}
              <div className="flex items-center gap-1 mt-2 flex-wrap">
                {wf.tasks.map((task, i) => (
                  <span key={`${task}-${i}`} className="flex items-center gap-1">
                    {i > 0 && <span className="text-board-muted text-[10px]">→</span>}
                    <span className="text-xs bg-board-bg border border-board-border rounded px-1.5 py-0.5 text-board-muted">
                      {task}
                    </span>
                  </span>
                ))}
              </div>

              {/* ID when name is shown */}
              {wf.name && (
                <div className="text-[10px] text-board-muted font-mono mt-1.5">{wf.id}</div>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
