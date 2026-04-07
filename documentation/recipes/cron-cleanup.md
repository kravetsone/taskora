# Scheduled Cleanup with DLQ

A periodic cleanup task using built-in scheduling and dead letter queue monitoring.

```ts
import { createTaskora } from "taskora"
import { redisAdapter } from "taskora/redis"

// Retention is ON by default (completed: 1h/100, failed: 7d/300)
// Override if needed:
const taskora = createTaskora({
  adapter: redisAdapter("redis://localhost:6379"),
  retention: {
    failed: { maxAge: "14d", maxItems: 1_000 },
  },
})

// Cleanup task
const cleanupExpiredTask = taskora.task("cleanup-expired", {
  schedule: {
    every: "6h",
    onMissed: "skip", // if scheduler was down, just skip missed runs
  },
  timeout: 300_000, // 5 minute timeout
  handler: async (data, ctx) => {
    ctx.log.info("Starting cleanup")

    // Clean expired sessions
    const sessions = await db.session.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    })
    ctx.log.info("Cleaned sessions", { count: sessions.count })
    ctx.progress(50)

    // Clean orphaned uploads
    const uploads = await db.upload.deleteMany({
      where: {
        createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        processed: false,
      },
    })
    ctx.log.info("Cleaned uploads", { count: uploads.count })
    ctx.progress(100)

    return { sessions: sessions.count, uploads: uploads.count }
  },
})

// Health monitoring — check DLQ size periodically
const healthCheckTask = taskora.task("health-check", {
  schedule: { every: "5m" },
  handler: async (data, ctx) => {
    const stats = await taskora.inspect().stats()

    if (stats.failed > 100) {
      ctx.log.error("High failure count", { failed: stats.failed })
      await alertOncall(`Queue health: ${stats.failed} failed jobs`)
    }

    if (stats.waiting > 10_000) {
      ctx.log.warn("Queue backlog growing", { waiting: stats.waiting })
    }

    return stats
  },
})

// Manual DLQ management
async function retryAllFailedJobs() {
  const count = await taskora.deadLetters.retryAll()
  console.log(`Retried ${count} failed jobs`)
}

await taskora.start()
```

## Schedule Management at Runtime

```ts
// Pause cleanup during maintenance
await taskora.schedules.pause("cleanup-expired")

// Resume
await taskora.schedules.resume("cleanup-expired")

// Run immediately
const handle = await taskora.schedules.trigger("cleanup-expired")
const result = await handle.result

// Check schedule status
const schedules = await taskora.schedules.list()
for (const s of schedules) {
  console.log(`${s.name}: next=${s.nextRun}, paused=${s.paused}`)
}
```
