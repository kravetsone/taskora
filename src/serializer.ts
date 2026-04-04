import type { Taskora } from "./types.js";

export function json(): Taskora.Serializer {
  return {
    serialize: (value) => JSON.stringify(value),
    deserialize: (raw) => JSON.parse(raw),
  };
}
