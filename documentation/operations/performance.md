# Performance

Taskora's performance depends on three axes: which Redis-compatible server you use, which Node.js runtime, and how Redis is configured. This page covers all three with real benchmark data and practical tuning advice.

All numbers below are from taskora's built-in benchmark suite (`@taskora/bench`) running against Docker containers on the same machine. They reflect relative differences — absolute numbers depend on hardware, network, and payload size.

## Redis-Compatible Servers

Taskora works with any server that speaks the Redis protocol. The three main options:

| Server | Description |
|---|---|
| **Redis 7** | The original. Single-threaded, battle-tested, widest ecosystem. |
| **Valkey 8** | Redis fork (Linux Foundation). Drop-in compatible, same protocol. |
| **Dragonfly** | Multi-threaded reimplementation. Different storage engine. |

### Throughput (ops/sec, Node.js v22, median of 3 runs)

| Benchmark | Redis 7 | Valkey 8 | Dragonfly |
|---|---:|---:|---:|
| enqueue (single) | 5,275 | 5,402 | 1,229 |
| enqueue (bulk, batch=50) | 80,798 | 93,345 | 10,622 |
| process (c=1) | 5,306 | 5,563 | 1,404 |
| process (c=100) | 30,799 | 36,152 | 1,781 |
| latency throughput | 4,429 | 5,169 | 807 |

### Latency (ms)

| Server | p50 | p95 | p99 |
|---|---:|---:|---:|
| Redis 7 | 0.39 | 0.74 | 1.20 |
| Valkey 8 | 0.33 | 0.60 | 0.93 |
| Dragonfly | 2.09 | 2.97 | 4.14 |

### Memory per job

| Server | B/job |
|---|---:|
| Redis 7 | 355 |
| Valkey 8 | 324 |
| Dragonfly | 274 |

### Takeaways

- **Redis and Valkey** are both excellent. Valkey is slightly faster at high concurrency and has better tail latency. Switching between them is a Docker image swap — no code changes.
- **Dragonfly** is 5–15x slower on taskora workloads. Dragonfly is multi-threaded, but its Lua engine serializes script execution. Since taskora uses atomic Lua scripts for every state transition (enqueue, dequeue, ack, fail), this becomes the bottleneck. Dragonfly also requires the `--default_lua_flags=allow-undeclared-keys` flag because taskora constructs keys inside scripts.
- **Memory** differences are modest. Dragonfly's storage engine is the most compact (274 B/job), but the gap narrows with Redis tuning (see [below](#hash-max-listpack-value)).

::: tip Recommendation
Use **Redis** or **Valkey** — whichever your team is more comfortable operating. If you're starting fresh, Valkey is a strong default.
:::

## Runtimes

Taskora runs on Bun, Node.js, and Deno. The runtime affects client-side overhead — serialization, event loop scheduling, and ioredis internals.

### Throughput (ops/sec, Redis 7, median of 3 runs)

| Benchmark | Bun | Node.js v22 | Deno |
|---|---:|---:|---:|
| enqueue (single) | 11,928 | 5,275 | 13,479 |
| enqueue (bulk, batch=50) | 128,407 | 80,798 | 135,077 |
| process (c=1) | 10,333 | 5,306 | 11,368 |
| process (c=100) | 42,594 | 30,799 | 52,008 |
| latency throughput | 8,053 | 4,429 | 8,958 |

### Latency (ms, Redis 7)

| Runtime | p50 | p95 | p99 |
|---|---:|---:|---:|
| Bun | 0.21 | 0.31 | 0.93 |
| Node.js v22 | 0.39 | 0.74 | 1.20 |
| Deno | 0.19 | 0.47 | 0.76 |

### Takeaways

- **Deno** is the fastest runtime across all benchmarks — 1.1–1.7x Bun, 1.4–2.5x Node. It also has the best p50 latency (0.19ms). Deno runs ioredis through its Node.js compatibility layer. Use `deno run -A --unstable-sloppy-imports` to run.
- **Bun** is close to Deno on throughput and has the tightest p95 (0.31ms). Roughly 2x Node on enqueue and single-threaded processing.
- **Node.js** is the slowest on raw throughput but has consistent, predictable performance. For production deployments where stability matters more than peak speed, Node is solid.

::: info
These benchmarks measure the full queue pipeline (serialize → Lua script → Redis → deserialize). The runtime difference is only the client-side overhead — Redis is the same in all cases.
:::

## Redis Drivers

Taskora ships two Redis drivers: **ioredis** (Node.js library, works on all runtimes) and a **Bun native driver** (`taskora/redis/bun`) that uses `Bun.RedisClient` — Bun's built-in Redis client with auto-pipelining.

### Throughput (ops/sec, Bun runtime, Redis 7, median of 3 runs)

| Benchmark | ioredis | Bun native |
|---|---:|---:|
| enqueue (single) | 11,928 | 11,391 |
| enqueue (bulk, batch=50) | 128,407 | 125,853 |
| process (c=1) | 10,333 | 10,310 |
| process (c=100) | 42,594 | 42,700 |
| latency throughput | 8,053 | 8,001 |

### Latency (ms)

| Driver | p50 | p95 | p99 |
|---|---:|---:|---:|
| ioredis | 0.21 | 0.31 | 0.93 |
| Bun native | 0.21 | 0.29 | 0.91 |

### Takeaways

The two drivers are **effectively identical** in performance. Bun's auto-pipelining (batching same-tick `.send()` calls into one round trip) matches ioredis's pipeline behavior, and the overhead of RESP parsing is negligible vs. the Lua script execution time on the server.

Choose based on operational constraints:

| | ioredis (`taskora/redis`) | Bun native (`taskora/redis/bun`) |
|---|---|---|
| **Runtimes** | Bun, Node.js, Deno | Bun only |
| **Cluster** | Yes | No |
| **Sentinel** | Yes | No |
| **Peer deps** | `ioredis` | None (built-in) |

If you need Cluster or Sentinel, use ioredis. If you're on Bun and want zero peer deps, the Bun driver is a safe choice with no performance trade-off.

## Redis Tuning

### `hash-max-listpack-value`

**This is the single most impactful Redis tuning knob for taskora.**

Taskora stores every job as a single Redis hash. Redis 7 keeps a hash in compact `listpack` encoding as long as two conditions hold:

- number of fields ≤ `hash-max-listpack-entries` (default `128` — taskora uses ~10-15 fields, well within limit)
- every field value ≤ `hash-max-listpack-value` bytes (default **`64`**)

The second condition is the one that bites. If your job's serialized `data` or `result` exceeds 64 bytes — which most real-world payloads do — Redis promotes the entire hash from `listpack` to `hashtable` encoding. The per-field overhead jumps from ~2 bytes to ~80 bytes, and a 10-field hash that was using ~150 bytes suddenly costs ~900 bytes.

**Fix: raise the threshold in `redis.conf`:**

```
hash-max-listpack-value 1024
```

With this setting, payloads up to ~1 KB stay in the compact encoding. For most task queues where job payloads are a few hundred bytes of JSON, this keeps every job in listpack and gives you the best memory efficiency.

#### Memory impact

| Payload size | Default (64) | Tuned (1024) |
|---|---|---|
| < 64 B | ~150 B/job (listpack) | ~150 B/job (listpack) |
| 64–1024 B | ~900 B/job (hashtable) | ~200–400 B/job (listpack) |
| > 1024 B | ~900+ B/job (hashtable) | ~900+ B/job (hashtable) |

The sweet spot is the middle row — medium payloads where the tuning makes a 2–4x difference in memory per job. If you're running 1M concurrent jobs, that's the difference between 900 MB and 300 MB of Redis memory.

#### How to apply

**redis.conf:**
```
hash-max-listpack-value 1024
```

**Redis CLI (runtime, non-persistent):**
```
CONFIG SET hash-max-listpack-value 1024
```

**Docker Compose:**
```yaml
services:
  redis:
    image: redis:7-alpine
    command: redis-server --hash-max-listpack-value 1024
```

### Connection pool sizing

Taskora uses a small number of Redis connections per process:

| Connection | Purpose | Count |
|---|---|---|
| Main | Commands, Lua scripts, enqueue/ack | 1 |
| Blocking | `BZPOPMIN` per task (worker dequeue) | 1 per task |
| Subscriber | `XREAD BLOCK` for events + `JobWaiter` | 1 (lazy, shared) |
| Cancel | `SUBSCRIBE` for cancel pub/sub | 1 per worker |

A typical process with 3 tasks and a worker uses ~6 connections. Redis's default `maxclients` is 10,000, so connection limits are rarely an issue unless you're running hundreds of taskora processes against one Redis.

If you're behind a Redis proxy (e.g. Envoy, HAProxy) or using Redis Cluster with a connection pool, size the pool to at least `2 + number_of_tasks` per taskora process.

### `maxmemory-policy`

Taskora manages its own retention (completed/failed job cleanup via configurable `retention` options). Redis `maxmemory-policy` should be set to **`noeviction`** — if Redis starts evicting keys on its own, it may silently drop in-flight jobs or metadata hashes.

```
maxmemory-policy noeviction
```

This is the default in most Redis deployments, but verify it in production.

## Running Benchmarks

Taskora ships a benchmark suite in `packages/bench` that you can run against any store and runtime.

### Quick start

```bash
# Default: bun + redis, all benchmarks, taskora vs BullMQ
bun run bench

# Pick a store
bun run bench -- --store valkey
bun run bench -- --store dragonfly

# Pick a runtime
bun run bench:node               # Node.js (via tsx)
bun run bench:deno               # Deno

# Compare ioredis vs Bun native driver (Bun only)
bun run bench -- --libraries taskora,taskora-bun

# Filter libraries and benchmarks
bun run bench -- --libraries taskora --benchmarks enqueue-single,enqueue-bulk

# JSON output for CI / scripts
bun run bench -- --json
```

### Options

| Flag | Default | Values |
|---|---|---|
| `--store` | `redis` | `redis`, `valkey`, `dragonfly` |
| `--libraries` | `taskora,bullmq` | `taskora`, `taskora-bun`, `bullmq` (comma-separated) |
| `--benchmarks` | all | `enqueue-single`, `enqueue-bulk`, `process-single`, `process-concurrent`, `latency` |
| `--iterations` | `3` | number of measured runs per benchmark |
| `--json` | off | machine-readable output |

### External Redis

By default the suite starts a Docker container via testcontainers. To benchmark against an existing server:

```bash
REDIS_URL=redis://your-host:6379 bun run bench
```

::: warning
The benchmark suite runs `FLUSHDB` between iterations. Don't point it at a production Redis.
:::
