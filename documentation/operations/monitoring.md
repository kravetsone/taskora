# Monitoring

Patterns for monitoring taskora in production.

## Health Check Endpoint

```ts
app.get("/health/queue", async (req, res) => {
  const stats = await taskora.inspect().stats()

  const healthy =
    stats.failed < 100 &&
    stats.waiting < 10_000

  res.status(healthy ? 200 : 503).json(stats)
})
```

## Metrics Collection

Use app events to feed metrics into Prometheus, Datadog, or any metrics system:

```ts
taskora.on("task:completed", ({ task, duration }) => {
  metrics.histogram("taskora.job.duration_ms", duration, { task })
  metrics.increment("taskora.job.completed", { task })
})

taskora.on("task:failed", ({ task, willRetry }) => {
  if (willRetry) {
    metrics.increment("taskora.job.retried", { task })
  } else {
    metrics.increment("taskora.job.failed", { task })
  }
})

taskora.on("task:stalled", ({ task, action }) => {
  metrics.increment("taskora.job.stalled", { task, action })
})
```

## Periodic Stats Collection

```ts
setInterval(async () => {
  const stats = await taskora.inspect().stats()
  metrics.gauge("taskora.queue.waiting", stats.waiting)
  metrics.gauge("taskora.queue.active", stats.active)
  metrics.gauge("taskora.queue.delayed", stats.delayed)
  metrics.gauge("taskora.queue.failed", stats.failed)
}, 10_000)
```

## Alert Thresholds

Suggested alerts for production:

| Metric | Warning | Critical |
|---|---|---|
| `failed` count | > 50 | > 200 |
| `waiting` depth | > 5,000 | > 50,000 |
| Job duration P99 | > 30s | > 120s |
| Stalled jobs/hour | > 5 | > 20 |

## Dashboard Queries

Example queries for a Grafana/Prometheus dashboard:

- **Throughput:** `rate(taskora_job_completed_total[5m])` by task
- **Error rate:** `rate(taskora_job_failed_total[5m]) / rate(taskora_job_completed_total[5m])`
- **Queue depth:** `taskora_queue_waiting` by task
- **Latency P95:** `histogram_quantile(0.95, taskora_job_duration_ms_bucket)`

## Inspecting Individual Jobs

```ts
const job = await taskora.inspect().find(jobId)
if (job) {
  console.log(`State: ${job.state}`)
  console.log(`Attempt: ${job.attempt}`)
  console.log(`Error: ${job.error}`)
  console.log(`Logs:`, job.logs)
  console.log(`Timeline:`, job.timeline)
}
```
