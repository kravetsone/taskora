# Flow Control

Taskora provides three flow control strategies — debounce, throttle, and deduplicate — all implemented as atomic Lua scripts.

<FlowControlVisualizer />

## Debounce

Replace the previous pending job for the same key. Only the **last** dispatch within the delay window is processed.

```ts
searchIndex.dispatch(data, {
  debounce: {
    key: `reindex:${documentId}`,
    delay: "2s",
  },
})
```

**Use case:** Avoid redundant reindexing when a document is edited multiple times in quick succession. Only the final version is indexed.

### How It Works

1. First dispatch creates a delayed job
2. Subsequent dispatches with the same key **replace** the previous job (reset the delay timer)
3. When the delay elapses without a new dispatch, the job moves to the waiting queue

## Throttle

Rate-limit dispatches per key. Excess dispatches are **rejected**.

```ts
const handle = callExternalApi.dispatch(data, {
  throttle: {
    key: "stripe-api",
    max: 100,        // max 100 dispatches
    window: "1m",    // per 1 minute window
  },
})

if (!handle.enqueued) {
  console.log("Rate limited — try again later")
}
```

**Use case:** Respect external API rate limits by capping how many jobs can be enqueued in a time window.

### How It Works

1. Each dispatch increments a counter for the key
2. Counter resets when the window expires
3. If counter exceeds `max`, the dispatch is rejected (`handle.enqueued = false`)
4. With `throwOnReject: true`, throws `ThrottledError` instead

## Deduplicate

Skip dispatch if a job with the same key already exists in a matching state.

```ts
const handle = generateReport.dispatch(data, {
  deduplicate: {
    key: `report:${userId}`,
    while: ["waiting", "active"], // default: ["waiting", "delayed", "active"]
  },
})

if (!handle.enqueued) {
  console.log("Report already in progress:", handle.existingId)
}
```

**Use case:** Prevent duplicate report generation when a user clicks "Generate" multiple times.

### How It Works

1. Checks if a job with the same dedup key exists in any of the `while` states
2. If found, returns the existing job's ID and sets `handle.enqueued = false`
3. If not found, creates a new job and stores the dedup key
4. Dedup keys are automatically cleaned up when jobs complete or fail

## Throwing on Rejection

By default, throttle and dedup silently reject. Use `throwOnReject` for explicit error handling:

```ts
try {
  sendEmail.dispatch(data, {
    throttle: { key: "emails", max: 100, window: "1h" },
    throwOnReject: true,
  })
} catch (err) {
  if (err instanceof ThrottledError) {
    // err.key = "emails"
  }
  if (err instanceof DuplicateJobError) {
    // err.key, err.existingId
  }
}
```

## Combining Flow Control

Flow control options are **mutually exclusive** — use only one per dispatch call. Collect tasks are also mutually exclusive with all flow control options.
