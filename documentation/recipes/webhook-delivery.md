# Webhook Delivery

Reliable webhook delivery with exponential backoff and selective retry.

```ts
class Http4xxError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`)
  }
}

const deliverWebhook = app.task("deliver-webhook", {
  retry: {
    attempts: 8,
    backoff: "exponential",
    delay: 1000,
    maxDelay: 3600_000, // cap at 1 hour
    noRetryOn: [Http4xxError], // don't retry client errors
  },
  timeout: 30_000,
  handler: async (data: { url: string; payload: unknown; secret: string }, ctx) => {
    const body = JSON.stringify(data.payload)
    const signature = createHmac("sha256", data.secret).update(body).digest("hex")

    const res = await fetch(data.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
        "X-Delivery-Id": ctx.id,
        "X-Delivery-Attempt": String(ctx.attempt),
      },
      body,
      signal: ctx.signal,
    })

    if (res.status >= 400 && res.status < 500) {
      throw new Http4xxError(res.status) // permanent failure
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`) // retryable
    }

    return { status: res.status, deliveredAt: Date.now() }
  },
})

// Dispatch
deliverWebhook.dispatch({
  url: "https://api.partner.com/webhooks",
  payload: { event: "order.created", data: { id: "123" } },
  secret: process.env.WEBHOOK_SECRET,
})

// Monitor DLQ for permanently failed deliveries
const failures = await app.deadLetters.list({ task: "deliver-webhook" })
```

**Retry schedule** with exponential backoff: 1s → 2s → 4s → 8s → 16s → 32s → 64s → capped at 1h. Total window: ~2 minutes before giving up.
