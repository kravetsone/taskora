import { cn } from "@/lib/utils";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "danger" | "ghost";
  size?: "sm" | "md";
}

export function Button({
  variant = "default",
  size = "sm",
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center rounded-md font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none",
        size === "sm" && "text-xs px-2.5 py-1.5",
        size === "md" && "text-sm px-3 py-2",
        variant === "default" && "bg-board-primary text-white hover:bg-board-primary/80",
        variant === "danger" && "bg-board-danger text-white hover:bg-board-danger/80",
        variant === "ghost" && "text-board-muted hover:text-board-text hover:bg-board-border/50",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
