import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";

let container: StartedRedisContainer;

export async function setup() {
  container = await new RedisContainer("redis:7-alpine").start();
  process.env.REDIS_URL = container.getConnectionUrl();
}

export async function teardown() {
  await container.stop();
}
