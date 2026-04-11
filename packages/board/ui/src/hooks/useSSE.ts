import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type OverviewResponse } from "@/lib/api";

export function useSSE(tasks?: string[]) {
  const queryClient = useQueryClient();
  const esRef = useRef<EventSource | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = api.createEventSource(tasks);
    esRef.current = es;

    es.addEventListener("stats:update", (e) => {
      try {
        const { task, stats } = JSON.parse(e.data);
        // Directly patch the overview cache — no refetch
        queryClient.setQueryData<OverviewResponse>(["overview"], (old) => {
          if (!old) return old;
          const taskIdx = old.tasks.findIndex((t) => t.name === task);
          if (taskIdx === -1) return old;

          const newTasks = [...old.tasks];
          newTasks[taskIdx] = { ...newTasks[taskIdx], stats };

          // Recalculate totals
          const totals = { waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0, expired: 0, cancelled: 0 };
          for (const t of newTasks) {
            for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
              totals[key] += t.stats[key];
            }
          }

          return { ...old, tasks: newTasks, totals };
        });
      } catch {
        // ignore parse errors
      }
    });

    // Job events: soft-refresh job lists (background, no loading state)
    const softRefreshJobs = () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"], refetchType: "active" });
      queryClient.invalidateQueries({ queryKey: ["dlq"], refetchType: "active" });
    };

    es.addEventListener("job:completed", softRefreshJobs);
    es.addEventListener("job:failed", softRefreshJobs);
    es.addEventListener("job:active", softRefreshJobs);
    es.addEventListener("job:cancelled", softRefreshJobs);

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    return () => {
      es.close();
      esRef.current = null;
      setConnected(false);
    };
  }, [queryClient, tasks?.join(",")]);

  return connected;
}
