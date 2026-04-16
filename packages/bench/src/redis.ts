import Redis from "ioredis";
import type { StoreName } from "./types.js";

const STORE_IMAGES: Record<StoreName, string> = {
  redis: "redis:7-alpine",
  valkey: "valkey/valkey:8-alpine",
  dragonfly: "docker.dragonflydb.io/dragonflydb/dragonfly:latest",
};

let container: { stop(opts?: { timeout?: number }): Promise<void> } | undefined;
let redisUrl: string | undefined;

export async function setupRedis(store: StoreName = "redis"): Promise<string> {
  if (process.env.REDIS_URL) {
    redisUrl = process.env.REDIS_URL;
    return redisUrl;
  }

  const { GenericContainer, Wait } = await import("testcontainers");
  const image = STORE_IMAGES[store];

  const READY_LOG: Record<StoreName, RegExp> = {
    redis: /Ready to accept connections/,
    valkey: /Ready to accept connections/,
    dragonfly: /listening on 0\.0\.0\.0:6379/,
  };

  let builder = new GenericContainer(image)
    .withExposedPorts(6379)
    .withStartupTimeout(60_000)
    .withWaitStrategy(Wait.forLogMessage(READY_LOG[store]));

  // Dragonfly needs --logtostderr to emit startup messages to Docker logs,
  // and --default_lua_flags=allow-undeclared-keys because taskora (and BullMQ)
  // construct Redis keys inside Lua scripts rather than passing all via KEYS[].
  if (store === "dragonfly") {
    builder = builder.withCommand([
      "dragonfly",
      "--logtostderr",
      "--default_lua_flags=allow-undeclared-keys",
    ]);
  }

  const started = await builder.start();
  container = started;

  const host = started.getHost();
  const port = started.getMappedPort(6379);
  redisUrl = `redis://${host}:${port}`;
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

/**
 * Parse `used_memory:<bytes>` from Redis `INFO memory` output.
 * Returns 0 if the section is missing — callers can treat that as "unknown".
 */
export async function readUsedMemory(client: {
  info(section: string): Promise<string>;
}): Promise<number> {
  const info = await client.info("memory");
  const match = /^used_memory:(\d+)/m.exec(info);
  return match ? Number(match[1]) : 0;
}
