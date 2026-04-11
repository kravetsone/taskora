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
import { StatCard } from "@/components/StatCard";
import { api } from "@/lib/api";
import { formatDuration, formatNumber } from "@/lib/utils";

const TASK_COLORS = [
  "#3b82f6",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#06b6d4",
  "#ec4899",
  "#14b8a6",
];

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

  // Per-task throughput
  const taskNames = overview?.tasks.map((t) => t.name) ?? [];
  const { data: perTaskThroughput } = useQuery({
    queryKey: ["throughput-per-task", taskNames.join(",")],
    queryFn: async () => {
      const results: Record<string, Awaited<ReturnType<typeof api.getThroughput>>> = {};
      await Promise.all(
        taskNames.map(async (name) => {
          results[name] = await api.getThroughput(60000, 60, name);
        }),
      );
      return results;
    },
    enabled: taskNames.length > 0,
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

  // Build per-task chart data
  const perTaskChartData = perTaskThroughput
    ? throughput?.map((p, i) => {
        const row: Record<string, number | string> = {
          time: new Date(p.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        };
        for (const name of taskNames) {
          const d = perTaskThroughput[name]?.[i];
          row[name] = d ? d.completed + d.failed : 0;
        }
        return row;
      }) ?? []
    : [];

  const keysPerTask = overview.redis.dbSize
    ? Math.round((overview.redis.dbSize ?? 0) / Math.max(1, overview.tasks.length))
    : null;

  const memPerTask = overview.redis.usedMemoryBytes
    ? formatBytes(Math.round(overview.redis.usedMemoryBytes / Math.max(1, overview.tasks.length)))
    : null;

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

      {/* Global throughput chart */}
      {chartData.length > 0 && (
        <div className="rounded-lg border border-board-border bg-board-surface p-4">
          <h3 className="text-sm font-medium text-board-muted mb-3">Throughput (last hour)</h3>
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--board-border)" />
              <XAxis
                dataKey="time"
                tick={{ fontSize: 10, fill: "var(--board-text-muted)" }}
                interval="preserveStartEnd"
              />
              <YAxis tick={{ fontSize: 10, fill: "var(--board-text-muted)" }} width={35} />
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

      {/* Per-task throughput chart */}
      {perTaskChartData.length > 0 && taskNames.length > 1 && (
        <div className="rounded-lg border border-board-border bg-board-surface p-4">
          <h3 className="text-sm font-medium text-board-muted mb-3">Per-task throughput</h3>
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={perTaskChartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--board-border)" />
              <XAxis
                dataKey="time"
                tick={{ fontSize: 10, fill: "var(--board-text-muted)" }}
                interval="preserveStartEnd"
              />
              <YAxis tick={{ fontSize: 10, fill: "var(--board-text-muted)" }} width={35} />
              <Tooltip
                contentStyle={{
                  background: "var(--board-surface)",
                  border: "1px solid var(--board-border)",
                  borderRadius: 6,
                  fontSize: 11,
                }}
              />
              {taskNames.map((name, i) => (
                <Area
                  key={name}
                  type="monotone"
                  dataKey={name}
                  stroke={TASK_COLORS[i % TASK_COLORS.length]}
                  fill={TASK_COLORS[i % TASK_COLORS.length]}
                  fillOpacity={0.05}
                  strokeWidth={1.5}
                  stackId="1"
                />
              ))}
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
              <tr key={task.name} className="border-b border-board-border/50 hover:bg-board-border/20">
                <td className="px-4 py-2.5">
                  <Link to={`/tasks/${task.name}`} className="text-board-primary hover:underline font-medium">
                    {task.name}
                  </Link>
                </td>
                <td className="text-right px-3 py-2.5 tabular-nums">{formatNumber(task.stats.waiting)}</td>
                <td className="text-right px-3 py-2.5 tabular-nums text-cyan-400">{formatNumber(task.stats.active)}</td>
                <td className="text-right px-3 py-2.5 tabular-nums text-amber-400">{formatNumber(task.stats.delayed)}</td>
                <td className="text-right px-3 py-2.5 tabular-nums text-red-400">{formatNumber(task.stats.failed)}</td>
                <td className="text-right px-3 py-2.5 tabular-nums text-emerald-400">{formatNumber(task.stats.completed)}</td>
                <td className="text-right px-4 py-2.5 text-board-muted">{task.config.version}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Redis info */}
      <div className="rounded-lg border border-board-border bg-board-surface p-4">
        <h3 className="text-sm font-medium text-board-muted mb-3">Redis</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 text-xs">
          <div>
            <div className="text-board-muted">Version</div>
            <div className="font-medium mt-0.5">{overview.redis.version}</div>
          </div>
          <div>
            <div className="text-board-muted">Uptime</div>
            <div className="font-medium mt-0.5">{formatDuration(overview.redis.uptime * 1000)}</div>
          </div>
          <div>
            <div className="text-board-muted">Memory</div>
            <div className="font-medium mt-0.5">{overview.redis.usedMemory}</div>
          </div>
          {overview.redis.peakMemory && (
            <div>
              <div className="text-board-muted">Peak Memory</div>
              <div className="font-medium mt-0.5">{overview.redis.peakMemory}</div>
            </div>
          )}
          {overview.redis.dbSize != null && (
            <div>
              <div className="text-board-muted">Total Keys</div>
              <div className="font-medium mt-0.5">{formatNumber(overview.redis.dbSize)}</div>
            </div>
          )}
          {overview.redis.connectedClients != null && (
            <div>
              <div className="text-board-muted">Clients</div>
              <div className="font-medium mt-0.5">{overview.redis.connectedClients}</div>
            </div>
          )}
          {keysPerTask && (
            <div>
              <div className="text-board-muted">Avg Keys/Task</div>
              <div className="font-medium mt-0.5">~{formatNumber(keysPerTask)}</div>
            </div>
          )}
          {memPerTask && (
            <div>
              <div className="text-board-muted">Avg Mem/Task</div>
              <div className="font-medium mt-0.5">~{memPerTask}</div>
            </div>
          )}
        </div>
        <div className="mt-2">
          <span className={`text-xs ${overview.redis.connected ? "text-emerald-400" : "text-red-400"}`}>
            {overview.redis.connected ? "Connected" : "Disconnected"}
          </span>
          <span className="text-xs text-board-muted ml-3">App uptime: {formatDuration(overview.uptime)}</span>
        </div>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
