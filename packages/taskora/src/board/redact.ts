const DEFAULT_REDACT_KEYS = new Set([
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
  "authorization",
  "credential",
  "private_key",
  "privatekey",
]);

export function createRedactor(extraKeys?: string[]): (value: unknown) => unknown {
  const keys = new Set(DEFAULT_REDACT_KEYS);
  if (extraKeys) {
    for (const k of extraKeys) keys.add(k.toLowerCase());
  }

  function redact(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value !== "object") return value;

    if (Array.isArray(value)) {
      return value.map(redact);
    }

    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (keys.has(k.toLowerCase())) {
        result[k] = "[REDACTED]";
      } else if (typeof v === "object" && v !== null) {
        result[k] = redact(v);
      } else {
        result[k] = v;
      }
    }
    return result;
  }

  return redact;
}
