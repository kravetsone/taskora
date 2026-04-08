import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "@/components/Badge";
import { StatCard } from "@/components/StatCard";
import { api } from "@/lib/api";
import { formatDuration, formatNumber, relativeTime } from "@/lib/utils";

export function Overview() {
  const { data: overview } = useQuery({
    queryKey: ["overview"],
    queryFn: api.getOverview,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });

  const { data: throughput } = useQuery({
    queryKey: ["throughput"],
    queryFn: () => api.getThroughput(60000, 60),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });

  if (!overview) {
    return <div className="p-6 text-board-muted">Loading...</div>;
  }

  const chartData =
    throughput?.map((p) => ({
      time: new Date(p.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      completed: p.completed,
      failed: p.failed,
    })) ?? [];

  return (
    <div className="p-6 space-y-6">
      <h2 className="text-lg font-semibold">Overview</h2>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        <StatCard label="Waiting" value={overview.totals.waiting} color="text-blue-400" />
        <StatCard label="Active" value={overview.totals.active} color="text-cyan-400" />
        <StatCard label="Delayed" value={overview.totals.delayed} color="text-amber-400" />
        <StatCard label="Completed" value={overview.totals.completed} color="text-emerald-400" />
        <StatCard label="Failed" value={overview.totals.failed} color="text-red-400" />
        <StatCard label="Expired" value={overview.totals.expired} color="text-purple-400" />
        <StatCard label="Cancelled" value={overview.totals.cancelled} color="text-zinc-400" />
      </div>

      {/* Throughput chart */}
      {chartData.length > 0 && (
        <div className="rounded-lg border border-board-border bg-board-surface p-4">
          <h3 className="text-sm font-medium text-board-muted mb-3">Throughput (last hour)</h3>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--board-border)" />
              <XAxis
                dataKey="time"
                tick={{ fontSize: 10, fill: "var(--board-text-muted)" }}
                interval="preserveStartEnd"
              />
              <YAxis tick={{ fontSize: 10, fill: "var(--board-text-muted)" }} width={40} />
              <Tooltip
                contentStyle={{
                  background: "var(--board-surface)",
                  border: "1px solid var(--board-border)",
                  borderRadius: 6,
                  fontSize: 12,
                }}
              />
              <Area
                type="monotone"
                dataKey="completed"
                stroke="#22c55e"
                fill="#22c55e"
                fillOpacity={0.1}
                strokeWidth={1.5}
              />
              <Area
                type="monotone"
                dataKey="failed"
                stroke="#ef4444"
                fill="#ef4444"
                fillOpacity={0.1}
                strokeWidth={1.5}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Task table */}
      <div className="rounded-lg border border-board-border bg-board-surface overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-board-border text-board-muted text-xs">
              <th className="text-left px-4 py-2 font-medium">Task</th>
              <th className="text-right px-3 py-2 font-medium">Wait</th>
              <th className="text-right px-3 py-2 font-medium">Active</th>
              <th className="text-right px-3 py-2 font-medium">Delayed</th>
              <th className="text-right px-3 py-2 font-medium">Failed</th>
              <th className="text-right px-3 py-2 font-medium">Done</th>
              <th className="text-right px-4 py-2 font-medium">v</th>
            </tr>
          </thead>
          <tbody>
            {overview.tasks.map((task) => (
              <tr
                key={task.name}
                className="border-b border-board-border/50 hover:bg-board-border/20"
              >
                <td className="px-4 py-2.5">
                  <Link
                    to={`/tasks/${task.name}`}
                    className="text-board-primary hover:underline font-medium"
                  >
                    {task.name}
                  </Link>
                </td>
                <td className="text-right px-3 py-2.5 tabular-nums">
                  {formatNumber(task.stats.waiting)}
                </td>
                <td className="text-right px-3 py-2.5 tabular-nums text-cyan-400">
                  {formatNumber(task.stats.active)}
                </td>
                <td className="text-right px-3 py-2.5 tabular-nums text-amber-400">
                  {formatNumber(task.stats.delayed)}
                </td>
                <td className="text-right px-3 py-2.5 tabular-nums text-red-400">
                  {formatNumber(task.stats.failed)}
                </td>
                <td className="text-right px-3 py-2.5 tabular-nums text-emerald-400">
                  {formatNumber(task.stats.completed)}
                </td>
                <td className="text-right px-4 py-2.5 text-board-muted">{task.config.version}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Footer info */}
      <div className="flex items-center gap-4 text-xs text-board-muted">
        <span>Redis {overview.redis.version}</span>
        <span>{overview.redis.usedMemory}</span>
        <span>Uptime: {formatDuration(overview.uptime)}</span>
        <span className={overview.redis.connected ? "text-emerald-400" : "text-red-400"}>
          {overview.redis.connected ? "Connected" : "Disconnected"}
        </span>
      </div>
    </div>
  );
}
