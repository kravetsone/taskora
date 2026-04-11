import { cn, stateColor } from "@/lib/utils";

interface BadgeProps {
  state: string;
  className?: string;
}

export function Badge({ state, className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
        stateColor(state),
        className,
      )}
    >
      {state}
    </span>
  );
}
