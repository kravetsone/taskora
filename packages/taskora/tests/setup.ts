import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";

let container: StartedRedisContainer | undefined;

export async function setup() {
  // If the environment already provides a Redis URL, trust it and skip the
  // testcontainers spin-up. This is how CI matrix jobs run against a service
  // container (`services: redis:` in .github/workflows/test.yml) and how a
  // developer can iterate against a persistent local Redis without paying
  // Docker startup on every invocation.
  if (process.env.REDIS_URL) return;

  container = await new RedisContainer("redis:7-alpine").withStartupTimeout(60_000).start();
  process.env.REDIS_URL = container.getConnectionUrl();
}

export async function teardown() {
  // Only tear down the container we started — if REDIS_URL was pre-set, we
  // don't own it and must not touch it.
  if (container) await container.stop({ timeout: 10_000 });
}
