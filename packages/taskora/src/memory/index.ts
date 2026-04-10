import type { Taskora } from "../types.js";
import { MemoryBackend } from "./backend.js";

export { MemoryBackend } from "./backend.js";

export function memoryAdapter(): Taskora.Adapter {
  return new MemoryBackend();
}
