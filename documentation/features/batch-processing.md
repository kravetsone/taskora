# Batch Processing

Collect tasks accumulate individual items into batches before processing. The handler receives an array of items.

<CollectBatchVisualizer />

## Configuration

```ts
const batchInsertTask = taskora.task("batch-insert", {
  collect: {
    key: "db-inserts",
    delay: "2s",          // debounce: flush 2s after last item
    maxSize: 100,         // flush immediately at 100 items
    maxWait: "10s",       // hard deadline: flush 10s after first item
  },
  handler: async (items: { table: string; row: Record<string, unknown> }[], ctx) => {
    ctx.log.info(`Batch inserting ${items.length} rows`)
    await db.batchInsert(items)
    return { inserted: items.length }
  },
})
```

## Dispatching Items

Dispatch individual items as usual — they accumulate automatically:

```ts
batchInsertTask.dispatch({ table: "events", row: { type: "click", ts: Date.now() } })
batchInsertTask.dispatch({ table: "events", row: { type: "view", ts: Date.now() } })
batchInsertTask.dispatch({ table: "events", row: { type: "scroll", ts: Date.now() } })
// → handler receives all 3 items as an array (or more, depending on timing)
```

## Flush Triggers

Three triggers compete — whichever fires first causes the flush:

| Trigger | Behavior | Resets on new item? |
|---|---|---|
| `delay` (debounce) | Flush after N ms of inactivity | Yes |
| `maxSize` | Flush immediately when buffer reaches this size | N/A |
| `maxWait` | Hard deadline since first item after last flush | No |

### Debounce (`delay`)

The timer resets every time a new item arrives. If items keep coming, the flush is delayed until there's a gap.

### Max Size

Immediate flush when the buffer reaches `maxSize`. This is the "backpressure" trigger — it prevents unbounded memory growth.

### Max Wait

Hard deadline since the first item arrived after the last flush. Guarantees a maximum latency regardless of incoming rate.

## Dynamic Collect Key

The `key` can be a function for per-item routing:

```ts
const batchByRegionTask = taskora.task("batch-by-region", {
  collect: {
    key: (data: { region: string }) => `region:${data.region}`,
    delay: "5s",
    maxSize: 50,
  },
  handler: async (items, ctx) => {
    // items are grouped by region
    await processRegionBatch(items)
  },
})
```

## Peeking the Buffer

Sometimes you need to read what's sitting in the buffer *without* draining it — for example, to surface unflushed data alongside already-processed data in a live query path.

```ts
// Read-only snapshot of the current buffer — returns items in dispatch
// order (oldest → newest). Does not drain, does not reset the debounce
// timer, does not change when the flush fires.
const pending = await ingestMessagesTask.peekCollect(`chat:${chatId}`)

// Stats-only view — cheaper than peekCollect because it doesn't read
// payloads. Returns null when no buffer exists for the key.
const info = await ingestMessagesTask.inspectCollect(`chat:${chatId}`)
// → { count: 12, oldestAt: 1712678400000, newestAt: 1712678520000 } | null
```

### Live-context use case

A chat ingestion pipeline buffers group messages via `collect` and batches them into an LLM extraction job that writes decisions, risks, and todos into long-term project memory. The same pipeline also answers user questions in the same chat ("what did Kolya just say about auth?") and needs to include the most recent minutes of chat in the prompt.

The challenge: messages from the current collect cycle haven't been extracted yet — they're not in long-term memory. But they're sitting in the collect buffer. `peekCollect` gives the Q&A path read-only access to that unflushed window without double-writing to a parallel Redis list, without a separate TTL to keep in sync, and without any risk of disturbing the pending flush:

```ts
async function answerWithLiveContext(chatId: string, question: string) {
  const [longTerm, pending] = await Promise.all([
    memory.search(chatId, question),
    ingestMessagesTask.peekCollect(`chat:${chatId}`),
  ])
  return llm.complete(buildPrompt({ longTerm, pending, question }))
}
```

### Semantics

- **Non-destructive.** Peek never alters buffer state — no `LPOP`, no TTL reset, no side effects that would change when the flush fires.
- **Snapshot consistency.** The underlying read is a single atomic command (Redis `LRANGE` / memory `slice`), so the returned array always reflects a coherent point in time, even under concurrent dispatches or a flush running in parallel.
- **Ownership boundary.** Once the handler has claimed the batch — i.e. `moveToActive` has drained the items list into the job — `peekCollect` returns `[]` and `inspectCollect` returns `null`. This preserves the invariant that items belong to *either* the buffer *or* the handler, never both.
- **Empty array on any "no buffer" state.** Never dispatched to, already flushed, or the buffer was just drained — callers don't need to distinguish these cases.
- **Throws on non-collect tasks.** Calling `peekCollect` / `inspectCollect` on a task without a `collect` config throws a `TaskoraError` — silently returning `[]` would mask a config bug.
- **Deserialized.** Items come back as `TInput[]` (via the task's serializer), not raw serialized blobs. Individual deserialization failures are skipped so one bad item can't hide the rest of the snapshot.
- **Dynamic `collect.key`.** When `key` is a function, pass the already-resolved string to `peekCollect` — same as what you'd compute for logging or tracing.

### What about retaining flushed history?

A tempting-looking knob would be `collect: { retain: { size, ttl } }` — keep the last N drained items around so callers can peek them after the flush. **Taskora deliberately doesn't offer this.**

Once a batch has been drained, those items are the handler's responsibility — they've been processed, extracted, and written to whatever downstream storage the handler owns. A retain list would duplicate that data with a looser TTL, creating overlap where the same items appear in both "raw retained" and "persisted derivative" forms, forcing consumers to de-duplicate.

The right boundary is: **`collect` holds items that haven't been processed yet; once processed, they belong to the handler's output storage.** `peekCollect` preserves that boundary. `retain` would violate it.

## Limitations

- Collect tasks are **mutually exclusive** with debounce, throttle, and deduplicate dispatch options
- `dispatch()` returns a lightweight `ResultHandle` (push confirmation only — no per-item result tracking)
- Items accumulate in Redis as a list per key

## Redis Implementation

Under the hood:
1. Each `dispatch()` pushes the item to a Redis list (`collect:{key}:items`)
2. A sentinel delayed job tracks the debounce timer (replaced on each dispatch)
3. `maxSize` triggers an immediate flush inline in the Lua script
4. At dequeue time (`moveToActive.lua`), the worker drains the buffer into the job's `:data` key
