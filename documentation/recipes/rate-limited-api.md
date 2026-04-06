# Rate-Limited API Calls

Call external APIs while respecting rate limits using throttle and concurrency controls.

```ts
const callStripeApi = app.task("stripe-api-call", {
  concurrency: 5, // max 5 parallel API calls
  timeout: 30_000,
  retry: {
    attempts: 3,
    backoff: "exponential",
    delay: 2000,
  },
  handler: async (data: { method: string; params: Record<string, unknown> }, ctx) => {
    const res = await fetch(`https://api.stripe.com/v1/${data.method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET}` },
      body: new URLSearchParams(data.params as any),
      signal: ctx.signal,
    })

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after")) * 1000
      throw ctx.retry({ delay: retryAfter, reason: "Stripe rate limit" })
    }

    if (!res.ok) throw new Error(`Stripe API error: ${res.status}`)

    return await res.json()
  },
})

// Dispatch with throttle — max 25 requests per second
callStripeApi.dispatch(
  { method: "customers", params: { email: "user@example.com" } },
  { throttle: { key: "stripe", max: 25, window: "1s" } },
)

// Per-customer concurrency limit
callStripeApi.dispatch(
  { method: "charges", params: { customer: "cus_123", amount: "1000" } },
  {
    concurrencyKey: `stripe:cus_123`,
    concurrencyLimit: 1, // one charge at a time per customer
  },
)
```

## Pattern: Automatic Rate Limit Detection

```ts
handler: async (data, ctx) => {
  const res = await callApi(data)

  if (res.status === 429) {
    // Use the API's retry-after header for precise backoff
    const delay = Number(res.headers.get("retry-after")) * 1000 || 5000
    throw ctx.retry({ delay })
  }

  return res.data
}
```

The `ctx.retry({ delay })` override bypasses the configured backoff strategy and uses the API's suggested retry delay instead.
