import { cn, formatNumber } from "@/lib/utils";

interface StatCardProps {
  label: string;
  value: number;
  color?: string;
}

export function StatCard({ label, value, color }: StatCardProps) {
  return (
    <div className="rounded-lg border border-board-border bg-board-surface p-4">
      <div className={cn("text-2xl font-bold tabular-nums", color ?? "text-board-text")}>
        {formatNumber(value)}
      </div>
      <div className="text-xs text-board-muted mt-1 uppercase tracking-wider">{label}</div>
    </div>
  );
}
