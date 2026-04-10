import Redis from "ioredis";

export function createTestRedis(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL not set. Is the global setup running?");
  }
  return new Redis(url);
}

export async function cleanRedis(redis: Redis): Promise<void> {
  await redis.flushdb();
}
