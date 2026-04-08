# taskora

Task queue for Node.js. TypeScript-first, Celery-inspired, batteries-included.

> **Work in progress** — see [https://kravetsone.github.io/taskora/](https://kravetsone.github.io/taskora/) for the full vision.

## Install

```bash
npm install taskora
```

## Runs everywhere — tested everywhere

Every commit runs the full 300-test integration suite against a live Redis on **every supported runtime × driver combination**, in parallel on CI:

| Runtime | Driver | |
|---|---|---|
| Node 20 (LTS) | `taskora/redis` (ioredis) | 300 / 300 |
| Bun 1.3+ | `taskora/redis/ioredis` | 300 / 300 |
| Bun 1.3+ | `taskora/redis/bun` (native `Bun.RedisClient`) | 300 / 300 |
| Deno 2.x | `taskora/redis` (via `npm:` specifier) | 300 / 300 |

That is **1,200 live-Redis test runs per push** — covering Lua scripts, blocking dequeues, pub/sub cancellation, distributed leader election, workflow DAGs, schedulers, flow control, and DLQ management. The release workflow is gated on every cell being green. See [Cross-runtime CI](https://kravetsone.github.io/taskora/testing/cross-runtime) for the full matrix, the bugs this matrix caught, and how to reproduce any cell locally.

## License

MIT
