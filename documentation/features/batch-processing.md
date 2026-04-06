# Batch Processing

Collect tasks accumulate individual items into batches before processing. The handler receives an array of items.

<CollectBatchVisualizer />

## Configuration

```ts
const batchInsert = app.task("batch-insert", {
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
batchInsert.dispatch({ table: "events", row: { type: "click", ts: Date.now() } })
batchInsert.dispatch({ table: "events", row: { type: "view", ts: Date.now() } })
batchInsert.dispatch({ table: "events", row: { type: "scroll", ts: Date.now() } })
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
const batchByRegion = app.task("batch-by-region", {
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
