# Redis Tuning

Production tuning for taskora's Redis backend. These settings affect memory efficiency and throughput — they're optional but recommended.

## Redis vs Valkey vs Dragonfly

Taskora works with any Redis-protocol-compatible server. Here's how the three main options compare on real taskora workloads (Node.js v22, Docker containers, default settings):

### Throughput (ops/sec, median of 3 runs)

| Benchmark | Redis 7 | Valkey 8 | Dragonfly |
|---|---:|---:|---:|
| enqueue (single) | 5,275 | 5,402 | 1,229 |
| enqueue (bulk, batch=50) | 80,798 | 93,345 | 10,622 |
| process (c=1) | 5,306 | 5,563 | 1,404 |
| process (c=100) | 30,799 | 36,152 | 1,781 |
| latency throughput | 4,429 | 5,169 | 807 |

### Latency (ms)

| Store | p50 | p95 | p99 |
|---|---:|---:|---:|
| Redis 7 | 0.39 | 0.74 | 1.20 |
| Valkey 8 | 0.33 | 0.60 | 0.93 |
| Dragonfly | 2.09 | 2.97 | 4.14 |

### Memory per job

| Store | B/job (enqueue-single) |
|---|---:|
| Redis 7 | 355 |
| Valkey 8 | 324 |
| Dragonfly | 274 |

### Takeaways

- **Redis and Valkey** are both excellent choices. Valkey is slightly faster at high concurrency and has better tail latency. Both are fully compatible — switching is a drop-in image swap.
- **Dragonfly** is 5–15x slower on taskora workloads. Dragonfly is multi-threaded but serializes Lua script execution. Since taskora (and BullMQ) use atomic Lua scripts for every state transition, this becomes the bottleneck. Dragonfly also requires `--default_lua_flags=allow-undeclared-keys` because taskora constructs keys inside Lua scripts.
- **Memory**: Dragonfly uses the least memory per job (274 B), Valkey is in the middle (324 B), Redis uses the most (355 B). The difference is modest — all three stay compact with small payloads.

::: tip
If you're choosing between Redis and Valkey, either works. If you're considering Dragonfly for its memory efficiency or multi-threaded architecture, be aware that Lua-heavy workloads like task queues don't benefit from Dragonfly's threading model.
:::

## `hash-max-listpack-value`

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

### Memory impact

| Payload size | Default (64) | Tuned (1024) |
|---|---|---|
| < 64 B | ~150 B/job (listpack) | ~150 B/job (listpack) |
| 64–1024 B | ~900 B/job (hashtable) | ~200–400 B/job (listpack) |
| > 1024 B | ~900+ B/job (hashtable) | ~900+ B/job (hashtable) |

The sweet spot is the middle row — medium payloads where the tuning makes a 2–4x difference in memory per job. If you're running 1M concurrent jobs, that's the difference between 900 MB and 300 MB of Redis memory.

### How to apply

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

## Connection pool sizing

Taskora uses a small number of Redis connections per process:

| Connection | Purpose | Count |
|---|---|---|
| Main | Commands, Lua scripts, enqueue/ack | 1 |
| Blocking | `BZPOPMIN` per task (worker dequeue) | 1 per task |
| Subscriber | `XREAD BLOCK` for events + `JobWaiter` | 1 (lazy, shared) |
| Cancel | `SUBSCRIBE` for cancel pub/sub | 1 per worker |

A typical process with 3 tasks and a worker uses ~6 connections. Redis's default `maxclients` is 10,000, so connection limits are rarely an issue unless you're running hundreds of taskora processes against one Redis.

If you're behind a Redis proxy (e.g. Envoy, HAProxy) or using Redis Cluster with a connection pool, size the pool to at least `2 + number_of_tasks` per taskora process.

## `maxmemory-policy`

Taskora manages its own retention (completed/failed job cleanup via configurable `retention` options). Redis `maxmemory-policy` should be set to **`noeviction`** — if Redis starts evicting keys on its own, it may silently drop in-flight jobs or metadata hashes.

```
maxmemory-policy noeviction
```

This is the default in most Redis deployments, but verify it in production.
