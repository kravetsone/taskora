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
| enqueue (single) | 11,267 | 5,275 | 12,183 \* |
| enqueue (bulk, batch=50) | 124,340 | 80,798 | — |
| process (c=1) | 10,421 | 5,306 | — |
| process (c=100) | 29,097 | 30,799 | — |
| latency throughput | 3,746 | 4,429 | — |

\* Deno number is from a single-iteration run; full suite data pending.

### Latency (ms, Redis 7)

| Runtime | p50 | p95 | p99 |
|---|---:|---:|---:|
| Bun | 0.40 | 1.06 | 1.78 |
| Node.js v22 | 0.39 | 0.74 | 1.20 |

### Takeaways

- **Bun** has the fastest enqueue and single-threaded processing — roughly 2x Node on those paths. The difference comes from Bun's faster `crypto.randomUUID()`, tighter event loop, and optimized ioredis import.
- **Node.js** has slightly better tail latency (p95/p99) and matches Bun on high-concurrency processing. For production deployments where latency consistency matters, Node is solid.
- **Deno** runs taskora via its Node.js compatibility layer. Early numbers look competitive. Use `deno run -A --unstable-sloppy-imports` to run.

::: info
These benchmarks measure the full queue pipeline (serialize → Lua script → Redis → deserialize). The runtime difference is only the client-side overhead — Redis is the same in all cases.
:::

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

# Filter libraries and benchmarks
bun run bench -- --libraries taskora --benchmarks enqueue-single,enqueue-bulk

# JSON output for CI / scripts
bun run bench -- --json
```

### Options

| Flag | Default | Values |
|---|---|---|
| `--store` | `redis` | `redis`, `valkey`, `dragonfly` |
| `--libraries` | `taskora,bullmq` | comma-separated |
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
