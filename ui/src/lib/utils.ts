export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const abs = Math.abs(diff);
  const future = diff < 0;
  const prefix = future ? "in " : "";
  const suffix = future ? "" : " ago";

  if (abs < 1000) return "just now";
  if (abs < 60_000) return `${prefix}${Math.floor(abs / 1000)}s${suffix}`;
  if (abs < 3600_000) return `${prefix}${Math.floor(abs / 60_000)}m${suffix}`;
  if (abs < 86400_000) return `${prefix}${Math.floor(abs / 3600_000)}h${suffix}`;
  return `${prefix}${Math.floor(abs / 86400_000)}d${suffix}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3600_000)}h ${Math.floor((ms % 3600_000) / 60_000)}m`;
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const STATE_COLORS: Record<string, string> = {
  waiting: "bg-blue-500/20 text-blue-400",
  active: "bg-cyan-500/20 text-cyan-400",
  delayed: "bg-amber-500/20 text-amber-400",
  completed: "bg-emerald-500/20 text-emerald-400",
  failed: "bg-red-500/20 text-red-400",
  retrying: "bg-orange-500/20 text-orange-400",
  cancelled: "bg-zinc-500/20 text-zinc-400",
  expired: "bg-purple-500/20 text-purple-400",
  pending: "bg-zinc-500/20 text-zinc-400",
  running: "bg-cyan-500/20 text-cyan-400",
};

export function stateColor(state: string): string {
  return STATE_COLORS[state] ?? "bg-zinc-500/20 text-zinc-400";
}

const NODE_COLORS: Record<string, string> = {
  pending: "#71717a",
  active: "#06b6d4",
  completed: "#22c55e",
  failed: "#ef4444",
  cancelled: "#a1a1aa",
};

export function nodeColor(state: string): string {
  return NODE_COLORS[state] ?? "#71717a";
}
