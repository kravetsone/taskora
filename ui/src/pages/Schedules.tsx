import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/utils";

export function Schedules() {
  const queryClient = useQueryClient();

  const { data: schedules, isLoading } = useQuery({
    queryKey: ["schedules"],
    queryFn: api.getSchedules,
    refetchInterval: 30_000,
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

  if (isLoading) {
    return <div className="p-6 text-board-muted">Loading...</div>;
  }

  return (
    <div className="p-6 space-y-4">
      <h2 className="text-lg font-semibold">Schedules</h2>

      {!schedules?.length ? (
        <div className="text-board-muted text-sm">No schedules configured</div>
      ) : (
        <div className="rounded-lg border border-board-border bg-board-surface overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-board-border text-board-muted text-xs">
                <th className="text-left px-4 py-2 font-medium">Name</th>
                <th className="text-left px-3 py-2 font-medium">Task</th>
                <th className="text-left px-3 py-2 font-medium">Schedule</th>
                <th className="text-left px-3 py-2 font-medium">Next Run</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="text-right px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((sched) => (
                <tr
                  key={sched.name}
                  className="border-b border-board-border/50 hover:bg-board-border/20"
                >
                  <td className="px-4 py-2.5 font-medium">{sched.name}</td>
                  <td className="px-3 py-2.5 text-board-primary">{sched.config.task}</td>
                  <td className="px-3 py-2.5 font-mono text-xs text-board-muted">
                    {sched.config.cron ??
                      (sched.config.every ? `every ${sched.config.every}` : "-")}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-board-muted">
                    {sched.paused ? (
                      <span className="text-amber-400">paused</span>
                    ) : sched.nextRun ? (
                      relativeTime(sched.nextRun)
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge state={sched.paused ? "cancelled" : "active"} />
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex gap-1 justify-end">
                      {sched.paused ? (
                        <Button
                          variant="ghost"
                          onClick={() => resume.mutate(sched.name)}
                          disabled={resume.isPending}
                        >
                          Resume
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          onClick={() => pause.mutate(sched.name)}
                          disabled={pause.isPending}
                        >
                          Pause
                        </Button>
                      )}
                      <Button
                        onClick={() => trigger.mutate(sched.name)}
                        disabled={trigger.isPending}
                      >
                        Trigger
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() => {
                          if (confirm(`Delete schedule "${sched.name}"?`)) {
                            remove.mutate(sched.name);
                          }
                        }}
                        disabled={remove.isPending}
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
