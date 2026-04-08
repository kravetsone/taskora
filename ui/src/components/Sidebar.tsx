import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";

const links = [
  { to: "/", label: "Overview", icon: "~" },
  { to: "/tasks", label: "Tasks", icon: ">" },
  { to: "/schedules", label: "Schedules", icon: "@" },
  { to: "/workflows", label: "Workflows", icon: "#" },
  { to: "/dlq", label: "DLQ", icon: "!" },
];

export function Sidebar({ title }: { title: string }) {
  return (
    <aside className="w-52 shrink-0 border-r border-board-border bg-board-surface flex flex-col h-screen sticky top-0">
      <div className="p-4 border-b border-board-border">
        <h1 className="text-sm font-bold text-board-text">{title}</h1>
      </div>
      <nav className="flex-1 p-2 space-y-0.5">
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.to === "/"}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors",
                isActive
                  ? "bg-board-primary/10 text-board-primary"
                  : "text-board-muted hover:text-board-text hover:bg-board-border/50",
              )
            }
          >
            <span className="w-4 text-center font-mono text-xs opacity-60">{link.icon}</span>
            {link.label}
          </NavLink>
        ))}
      </nav>
      <div className="p-3 border-t border-board-border text-[10px] text-board-muted">
        taskora board
      </div>
    </aside>
  );
}
