import type { Taskora } from "./types.js";

export function createContext(options: {
  id: string;
  attempt: number;
  timestamp: number;
  signal: AbortSignal;
  onHeartbeat: () => void;
}): Taskora.Context {
  return {
    id: options.id,
    attempt: options.attempt,
    timestamp: options.timestamp,
    signal: options.signal,
    heartbeat: options.onHeartbeat,
  };
}
