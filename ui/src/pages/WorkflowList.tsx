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

      <div className="rounded-lg border border-board-border bg-board-surface overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-board-border text-board-muted text-xs">
              <th className="text-left px-4 py-2 font-medium">ID</th>
              <th className="text-left px-3 py-2 font-medium">State</th>
              <th className="text-right px-3 py-2 font-medium">Nodes</th>
              <th className="text-left px-3 py-2 font-medium">Tasks</th>
              <th className="text-right px-4 py-2 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && !workflows ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-board-muted">
                  Loading...
                </td>
              </tr>
            ) : !workflows?.length ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-board-muted">
                  No workflows
                </td>
              </tr>
            ) : (
              workflows.map((wf) => (
                <tr
                  key={wf.id}
                  className="border-b border-board-border/50 hover:bg-board-border/20"
                >
                  <td className="px-4 py-2.5">
                    <Link
                      to={`/workflows/${wf.id}`}
                      className="text-board-primary hover:underline font-mono text-xs"
                    >
                      {wf.id.slice(0, 12)}...
                    </Link>
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge state={wf.state} />
                  </td>
                  <td className="text-right px-3 py-2.5 tabular-nums text-board-muted">
                    {wf.nodeCount}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-board-muted">
                    {wf.terminalTasks.join(", ")}
                  </td>
                  <td className="text-right px-4 py-2.5 text-xs text-board-muted">
                    {relativeTime(wf.createdAt)}
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
