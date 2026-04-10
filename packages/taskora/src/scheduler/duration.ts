export type Duration = number | `${number}s` | `${number}m` | `${number}h` | `${number}d`;

const UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a human-readable duration string into milliseconds.
 * Accepts "30s", "5m", "2h", "1d", or a number (ms passthrough).
 */
export function parseDuration(value: Duration): number {
  if (typeof value === "number") {
    if (value <= 0 || !Number.isFinite(value)) {
      throw new Error(`Invalid duration: ${value} — must be a positive finite number`);
    }
    return value;
  }

  const match = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(value);
  if (!match) {
    throw new Error(`Invalid duration: "${value}" — expected format: "30s", "5m", "2h", or "1d"`);
  }

  const num = Number.parseFloat(match[1]);
  const unit = match[2];
  const ms = Math.round(num * UNITS[unit]);

  if (ms <= 0) {
    throw new Error(`Invalid duration: "${value}" — must be greater than 0`);
  }

  return ms;
}
