import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "@/lib/api";

export function Migrations() {
  const { taskName } = useParams<{ taskName: string }>();

  const { data: status, isLoading } = useQuery({
    queryKey: ["migrations", taskName],
    queryFn: () => api.getMigrations(taskName!),
    enabled: !!taskName,
  });

  if (!taskName) return null;

  if (isLoading || !status) {
    return <div className="p-6 text-board-muted">Loading...</div>;
  }

  // Build chart data from version distribution
  const versions = new Set<number>();
  for (const v of Object.keys(status.queue.byVersion)) versions.add(Number(v));
  for (const v of Object.keys(status.delayed.byVersion)) versions.add(Number(v));

  const chartData = [...versions].sort().map((v) => ({
    version: `v${v}`,
    queue: status.queue.byVersion[v] ?? 0,
    delayed: status.delayed.byVersion[v] ?? 0,
  }));

  return (
    <div className="p-6 space-y-4">
      <Link to={`/tasks/${taskName}`} className="text-xs text-board-muted hover:text-board-text">
        &larr; {taskName}
      </Link>
      <h2 className="text-lg font-semibold">Migrations: {taskName}</h2>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-md border border-board-border bg-board-surface p-3 text-xs">
          <div className="text-board-muted">Current Version</div>
          <div className="text-xl font-bold mt-1">v{status.version}</div>
        </div>
        <div className="rounded-md border border-board-border bg-board-surface p-3 text-xs">
          <div className="text-board-muted">Since</div>
          <div className="text-xl font-bold mt-1">v{status.since}</div>
        </div>
        <div className="rounded-md border border-board-border bg-board-surface p-3 text-xs">
          <div className="text-board-muted">Migrations</div>
          <div className="text-xl font-bold mt-1">{status.migrations}</div>
        </div>
        <div className="rounded-md border border-board-border bg-board-surface p-3 text-xs">
          <div className="text-board-muted">Can Bump Since</div>
          <div className="text-xl font-bold mt-1 text-emerald-400">v{status.canBumpSince}</div>
        </div>
      </div>

      {/* Safe indicator */}
      {status.canBumpSince > status.since && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-emerald-400">
          Safe to bump <code>since</code> to v{status.canBumpSince} — all older jobs have drained.
        </div>
      )}

      {/* Version distribution chart */}
      {chartData.length > 0 && (
        <div className="rounded-lg border border-board-border bg-board-surface p-4">
          <h3 className="text-sm font-medium text-board-muted mb-3">Version Distribution</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--board-border)" />
              <XAxis dataKey="version" tick={{ fontSize: 11, fill: "var(--board-text-muted)" }} />
              <YAxis tick={{ fontSize: 11, fill: "var(--board-text-muted)" }} width={40} />
              <Tooltip
                contentStyle={{
                  background: "var(--board-surface)",
                  border: "1px solid var(--board-border)",
                  borderRadius: 6,
                  fontSize: 12,
                }}
              />
              <Bar
                dataKey="queue"
                fill="#3b82f6"
                name="Queue (wait+active)"
                radius={[4, 4, 0, 0]}
              />
              <Bar dataKey="delayed" fill="#f59e0b" name="Delayed" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Oldest versions */}
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div className="rounded-md border border-board-border bg-board-surface p-3">
          <div className="text-board-muted mb-1">Oldest in Queue</div>
          <div className="font-medium">
            {status.queue.oldest !== null ? `v${status.queue.oldest}` : "empty"}
          </div>
        </div>
        <div className="rounded-md border border-board-border bg-board-surface p-3">
          <div className="text-board-muted mb-1">Oldest Delayed</div>
          <div className="font-medium">
            {status.delayed.oldest !== null ? `v${status.delayed.oldest}` : "empty"}
          </div>
        </div>
      </div>
    </div>
  );
}
