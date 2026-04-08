import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useSSE(tasks?: string[]) {
  const queryClient = useQueryClient();
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = api.createEventSource(tasks);
    esRef.current = es;

    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: ["overview"] });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      queryClient.invalidateQueries({ queryKey: ["dlq"] });
    };

    es.addEventListener("job:completed", invalidate);
    es.addEventListener("job:failed", invalidate);
    es.addEventListener("job:active", invalidate);
    es.addEventListener("job:cancelled", invalidate);
    es.addEventListener("stats:update", () => {
      queryClient.invalidateQueries({ queryKey: ["overview"] });
    });

    es.onerror = () => {
      // EventSource auto-reconnects
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [queryClient, tasks?.join(",")]);
}
