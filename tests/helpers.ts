export function url() {
  const u = process.env.REDIS_URL;
  if (!u) throw new Error("REDIS_URL not set");
  return u;
}

export async function waitFor(
  fn: () => Promise<boolean> | boolean,
  timeoutMs = 10_000,
  interval = 50,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
