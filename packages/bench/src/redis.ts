import Redis from "ioredis";

let containerModule: typeof import("@testcontainers/redis") | undefined;
let container: Awaited<ReturnType<(typeof containerModule)["RedisContainer"]["prototype"]["start"]>> | undefined;
let redisUrl: string | undefined;

export async function setupRedis(): Promise<string> {
  if (process.env.REDIS_URL) {
    redisUrl = process.env.REDIS_URL;
    return redisUrl;
  }

  const { RedisContainer } = await import("@testcontainers/redis");
  container = await new RedisContainer("redis:7-alpine")
    .withStartupTimeout(60_000)
    .start();
  redisUrl = container.getConnectionUrl();
  return redisUrl;
}

export function getRedisUrl(): string {
  if (!redisUrl) throw new Error("Redis not set up — call setupRedis() first");
  return redisUrl;
}

export async function teardownRedis(): Promise<void> {
  if (container) await container.stop({ timeout: 10_000 });
  container = undefined;
  redisUrl = undefined;
}

export async function flushRedis(url: string): Promise<void> {
  const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null });
  await client.connect();
  await client.flushdb();
  client.disconnect();
}

export function parseRedisUrl(url: string): { host: string; port: number } {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port) || 6379 };
}
