// `taskora/redis` is the canonical Redis adapter entry. It re-exports the ioredis
// driver — the most mature option and the historical default. Bun users may
// prefer `taskora/redis/bun`, which avoids the ioredis peer dependency entirely.
//
// Existing user code (`import { redisAdapter } from "taskora/redis"`) keeps
// working unchanged — `./redis` and `./redis/ioredis` are interchangeable.
export { redisAdapter } from "./ioredis.js";
