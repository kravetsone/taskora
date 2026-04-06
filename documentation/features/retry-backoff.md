# Retry & Backoff

Taskora provides flexible retry strategies with configurable backoff, jitter, and selective retry filtering.

<RetryBackoffVisualizer />

## Configuration

```ts
app.task("send-webhook", {
  retry: {
    attempts: 5,           // total attempts (1 original + 4 retries)
    backoff: "exponential", // "fixed" | "exponential" | "linear" | function
    delay: 1000,           // base delay in ms
    maxDelay: 60_000,      // cap at 60 seconds
    jitter: true,          // ±25% randomization (default: true)
  },
  handler: async (data, ctx) => {
    await deliverWebhook(data)
  },
})
```

## `attempts` — Total Attempts

`attempts: 3` means the handler runs **up to 3 times** total — 1 original execution + 2 retries.

## Backoff Strategies

### Fixed

Constant delay between retries.

```ts
retry: { attempts: 3, backoff: "fixed", delay: 2000 }
// Attempt 1: immediate
// Attempt 2: +2000ms
// Attempt 3: +2000ms
```

### Exponential

Delay doubles each time: `delay * 2^(attempt - 1)`.

```ts
retry: { attempts: 5, backoff: "exponential", delay: 1000 }
// Attempt 1: immediate
// Attempt 2: +1000ms
// Attempt 3: +2000ms
// Attempt 4: +4000ms
// Attempt 5: +8000ms
```

### Linear

Delay increases linearly: `delay * attempt`.

```ts
retry: { attempts: 5, backoff: "linear", delay: 1000 }
// Attempt 1: immediate
// Attempt 2: +1000ms
// Attempt 3: +2000ms
// Attempt 4: +3000ms
// Attempt 5: +4000ms
```

### Custom Function

Full control — return the delay in milliseconds for the given attempt.

```ts
retry: {
  attempts: 5,
  backoff: (attempt) => Math.min(attempt * 500 + 200, 30_000),
}
```

## Jitter

Jitter adds ±25% randomization to prevent thundering herd. It's **enabled by default**.

```ts
retry: { attempts: 3, backoff: "exponential", delay: 1000, jitter: true }
// Attempt 2: ~750ms – ~1250ms (instead of exactly 1000ms)
// Attempt 3: ~1500ms – ~2500ms (instead of exactly 2000ms)
```

Disable with `jitter: false`.

## `maxDelay` — Delay Cap

Prevents exponential backoff from growing unbounded.

```ts
retry: { attempts: 10, backoff: "exponential", delay: 1000, maxDelay: 30_000 }
// Attempts 1-5: 1s, 2s, 4s, 8s, 16s
// Attempts 6+: capped at 30s
```

## Selective Retry

### `retryOn` — Whitelist

Only retry for specific error types. All other errors fail immediately.

```ts
retry: {
  attempts: 3,
  retryOn: [NetworkError, TimeoutError],
}
```

### `noRetryOn` — Blacklist

Never retry for these error types. All other errors retry normally.

```ts
retry: {
  attempts: 3,
  noRetryOn: [ValidationError, AuthenticationError],
}
```

## Manual Retry

Use `ctx.retry()` inside the handler for programmatic retry control.

```ts
app.task("call-api", async (data, ctx) => {
  const res = await fetch(data.url)

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after")) * 1000
    throw ctx.retry({ delay: retryAfter, reason: "Rate limited" })
  }

  if (res.status === 503) {
    throw ctx.retry() // use configured backoff delay
  }

  return await res.json()
})
```

`RetryError` **always retries** — it bypasses `retryOn`/`noRetryOn` filters. The only limit is `attempts`.
