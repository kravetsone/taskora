import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { JsonView } from "@/components/JsonView";
import { api, type ScheduleInfo } from "@/lib/api";
import { relativeTime, cn } from "@/lib/utils";

export function Schedules() {
  const [expanded, setExpanded] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: schedules, isLoading } = useQuery({
    queryKey: ["schedules"],
    queryFn: api.getSchedules,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });

  const pause = useMutation({
    mutationFn: (name: string) => api.pauseSchedule(name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["schedules"] }),
  });

  const resume = useMutation({
    mutationFn: (name: string) => api.resumeSchedule(name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["schedules"] }),
  });

  const trigger = useMutation({
    mutationFn: (name: string) => api.triggerSchedule(name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["schedules"] }),
  });

  const remove = useMutation({
    mutationFn: (name: string) => api.deleteSchedule(name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["schedules"] }),
  });

  if (isLoading && !schedules) {
    return <div className="p-6 text-board-muted">Loading...</div>;
  }

  return (
    <div className="p-6 space-y-4">
      <h2 className="text-lg font-semibold">Schedules</h2>

      {!schedules?.length ? (
        <div className="text-board-muted text-sm">No schedules configured</div>
      ) : (
        <div className="space-y-2">
          {schedules.map((sched) => (
            <ScheduleCard
              key={sched.name}
              sched={sched}
              expanded={expanded === sched.name}
              onToggle={() => setExpanded(expanded === sched.name ? null : sched.name)}
              onPause={() => pause.mutate(sched.name)}
              onResume={() => resume.mutate(sched.name)}
              onTrigger={() => trigger.mutate(sched.name)}
              onDelete={() => {
                if (confirm(`Delete schedule "${sched.name}"?`)) {
                  remove.mutate(sched.name);
                }
              }}
              isPending={pause.isPending || resume.isPending || trigger.isPending || remove.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ScheduleCard({
  sched,
  expanded,
  onToggle,
  onPause,
  onResume,
  onTrigger,
  onDelete,
  isPending,
}: {
  sched: ScheduleInfo;
  expanded: boolean;
  onToggle: () => void;
  onPause: () => void;
  onResume: () => void;
  onTrigger: () => void;
  onDelete: () => void;
  isPending: boolean;
}) {
  // Load last job detail when expanded
  const { data: lastJob } = useQuery({
    queryKey: ["job", sched.lastJobId],
    queryFn: () => api.getJob(sched.lastJobId!),
    enabled: expanded && !!sched.lastJobId,
  });

  const schedExpression = sched.config.cron
    ? sched.config.cron
    : sched.config.every
      ? formatInterval(sched.config.every)
      : "-";

  return (
    <div className="rounded-lg border border-board-border bg-board-surface overflow-hidden">
      {/* Header — clickable */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-board-border/20 transition-colors"
      >
        <span className={cn("text-xs transition-transform", expanded && "rotate-90")}>
          ▸
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{sched.name}</span>
            <Badge state={sched.paused ? "cancelled" : "active"} />
            {sched.config.timezone && (
              <span className="text-[10px] text-board-muted">{sched.config.timezone}</span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-xs text-board-muted">
            <span>
              Task:{" "}
              <Link
                to={`/tasks/${sched.config.task}`}
                className="text-board-primary hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {sched.config.task}
              </Link>
            </span>
            <span className="font-mono">{schedExpression}</span>
            <span>
              {sched.paused
                ? "paused"
                : sched.nextRun
                  ? `next: ${relativeTime(sched.nextRun)}`
                  : ""}
            </span>
            {sched.lastRun && (
              <span>last: {relativeTime(sched.lastRun)}</span>
            )}
          </div>
        </div>
        <div className="flex gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          {sched.paused ? (
            <Button variant="ghost" onClick={onResume} disabled={isPending}>
              Resume
            </Button>
          ) : (
            <Button variant="ghost" onClick={onPause} disabled={isPending}>
              Pause
            </Button>
          )}
          <Button onClick={onTrigger} disabled={isPending}>
            Trigger
          </Button>
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-board-border px-4 py-3 space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div>
              <div className="text-board-muted">Type</div>
              <div className="font-medium mt-0.5">
                {sched.config.cron ? "Cron" : "Interval"}
              </div>
            </div>
            <div>
              <div className="text-board-muted">Expression</div>
              <div className="font-medium font-mono mt-0.5">{schedExpression}</div>
            </div>
            <div>
              <div className="text-board-muted">Overlap</div>
              <div className="font-medium mt-0.5">
                {sched.config.overlap ? "allowed" : "prevented"}
              </div>
            </div>
            <div>
              <div className="text-board-muted">On Missed</div>
              <div className="font-medium mt-0.5">{sched.config.onMissed ?? "skip"}</div>
            </div>
          </div>

          {/* Dispatch data */}
          {sched.config.data != null && (
            <div>
              <div className="text-xs text-board-muted mb-1">Dispatch data</div>
              <JsonView data={sched.config.data} maxHeight="120px" />
            </div>
          )}

          {/* Last execution */}
          <div className="rounded-md border border-board-border bg-board-bg p-3">
            <div className="text-xs text-board-muted mb-2">Last execution</div>
            {sched.lastJobId ? (
              <div className="space-y-2">
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-board-muted">Job:</span>
                  <Link
                    to={`/jobs/${sched.lastJobId}`}
                    className="text-board-primary hover:underline font-mono"
                  >
                    {sched.lastJobId.slice(0, 12)}...
                  </Link>
                  {lastJob && <Badge state={lastJob.state} />}
                  {sched.lastRun && (
                    <span className="text-board-muted">{relativeTime(sched.lastRun)}</span>
                  )}
                </div>
                {lastJob && (
                  <div className="text-xs space-y-1">
                    {lastJob.error && (
                      <div className="text-red-400 truncate">Error: {lastJob.error}</div>
                    )}
                    {lastJob.result != null && (
                      <div>
                        <span className="text-board-muted">Result: </span>
                        <span className="text-board-text font-mono">
                          {typeof lastJob.result === "string"
                            ? lastJob.result.slice(0, 80)
                            : JSON.stringify(lastJob.result).slice(0, 80)}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-xs text-board-muted">No executions yet</div>
            )}
          </div>

          {/* Task link + delete */}
          <div className="flex items-center justify-between">
            <Link
              to={`/tasks/${sched.config.task}`}
              className="text-xs text-board-primary hover:underline"
            >
              View all {sched.config.task} jobs →
            </Link>
            <Button variant="danger" onClick={onDelete} disabled={isPending}>
              Delete schedule
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatInterval(every: string | number): string {
  if (typeof every === "string") return `every ${every}`;
  const ms = Number(every);
  if (ms < 60_000) return `every ${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `every ${Math.round(ms / 60_000)}m`;
  if (ms < 86400_000) return `every ${Math.round(ms / 3600_000)}h`;
  return `every ${Math.round(ms / 86400_000)}d`;
}
