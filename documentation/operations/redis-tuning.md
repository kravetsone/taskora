# Redis Tuning

Production tuning for taskora's Redis backend. These settings affect memory efficiency and throughput — they're optional but recommended.

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

::: tip BullMQ gives the same recommendation
BullMQ has always used single-hash job storage and implicitly assumes operators tune this threshold. Taskora's pre-0.x split-storage layout masked the need, but since the single-hash migration (wireVersion 6) the same tuning applies.
:::

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
