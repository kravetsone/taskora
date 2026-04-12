/**
 * Lua scripts for atomic Redis state transitions.
 *
 * All scripts use split storage:
 *   {prefix}<jobId>       — Hash (ziplist): metadata (< 64 bytes per value)
 *   {prefix}<jobId>:data  — String: serialized input
 *   {prefix}<jobId>:result — String: serialized output
 *   {prefix}<jobId>:lock  — String (PX): distributed lock
 *
 * All keys share a {hash tag} for Redis Cluster compatibility.
 *
 * ── Wait-list ordering ─────────────────────────────────────────────
 *
 * The wait list is a sorted set (not a plain list), keyed by the
 * composite score `waitScore(priority, ts) = -priority * 1e13 + ts`.
 *
 * The ONLY hard guarantee is priority stratification: higher priority
 * produces a LOWER score, so `ZPOPMIN` always yields a higher-priority
 * job before any lower-priority one, regardless of when either was
 * dispatched.
 *
 * Within a priority band ordering is best-effort. The `ts` term gives
 * dequeue calls a rough wall-clock direction — older dispatches
 * generally go first — but there is no FIFO contract and users must
 * not rely on one. Two reasons it cannot be stronger:
 *
 *   1. `ts` has 1 ms granularity. Same-millisecond dispatches share
 *      one score and fall back to ZSET lex order on the UUID member,
 *      which is effectively random.
 *   2. Worker concurrency breaks FIFO at the execution layer even if
 *      the dequeue layer were perfectly ordered. With concurrency > 1
 *      multiple workers pop in parallel and finish in handler-duration
 *      order — the observable completion order has nothing to do with
 *      the dispatch order.
 *
 * If strict ordering matters, encode it via priority levels.
 *
 * Priority is bounded to ~100 in practice (score stays within 53-bit
 * double precision safely up to priority 1000). `ts` is a ms timestamp
 * around 1.7e12 for the foreseeable future, so the total score range
 * is comfortably within double precision.
 *
 * Every script that touches the wait list inlines the same formula
 * because Redis Lua scripts share no lexical scope. Search for
 * `-1e13` to find all the sites.
 */

// ── enqueue ──────────────────────────────────────────────────────────
// KEYS[1] = <task>:wait      (wait list)
// KEYS[2] = <task>:events    (event stream)
// KEYS[3] = <task>:marker    (marker sorted set — wakes blocked workers)
// ARGV[1] = jobPrefix        (e.g. "taskora:{send-email}:")
// ARGV[2] = jobId            (client-generated UUID)
// ARGV[3] = serialized data
// ARGV[4] = timestamp (ms)
// ARGV[5] = _v (version)
// ARGV[6] = priority
// ARGV[7] = maxAttempts
// ARGV[8] = expireAt (0 = no TTL)
// ARGV[9] = concurrencyKey ("" = none)
// ARGV[10] = concurrencyLimit ("0" = none)
// ARGV[11] = _wf ("" = none)
// ARGV[12] = _wfNode ("" = none)
// Returns: 1
export const ENQUEUE = `
local jobKey = ARGV[1] .. ARGV[2]
local dataKey = jobKey .. ':data'

redis.call('HSET', jobKey,
  'ts', ARGV[4],
  '_v', ARGV[5],
  'attempt', 1,
  'maxAttempts', ARGV[7],
  'state', 'waiting',
  'priority', ARGV[6])

if tonumber(ARGV[8]) > 0 then
  redis.call('HSET', jobKey, 'expireAt', ARGV[8])
end
if ARGV[9] ~= '' then
  redis.call('HSET', jobKey, 'concurrencyKey', ARGV[9], 'concurrencyLimit', ARGV[10])
end
if ARGV[11] ~= '' then
  redis.call('HSET', jobKey, '_wf', ARGV[11], '_wfNode', ARGV[12])
end

redis.call('SET', dataKey, ARGV[3])
local waitScore = -(tonumber(ARGV[6]) or 0) * 1e13 + (tonumber(ARGV[4]) or 0)
redis.call('ZADD', KEYS[1], waitScore, ARGV[2])
redis.call('ZADD', KEYS[3], 0, '0')

redis.call('XADD', KEYS[2], 'MAXLEN', '~', 10000, '*',
  'event', 'waiting', 'jobId', ARGV[2])

return 1
`;

// ── enqueueDelayed ───────────────────────────────────────────────────
// KEYS[1] = <task>:delayed   (delayed sorted set)
// KEYS[2] = <task>:events
// KEYS[3] = <task>:marker    (marker sorted set)
// ARGV[1] = jobPrefix
// ARGV[2] = jobId            (client-generated UUID)
// ARGV[3] = serialized data
// ARGV[4] = timestamp (ms)
// ARGV[5] = _v
// ARGV[6] = delay (ms)
// ARGV[7] = priority
// ARGV[8] = maxAttempts
// ARGV[9] = expireAt (0 = no TTL)
// ARGV[10] = concurrencyKey ("" = none)
// ARGV[11] = concurrencyLimit ("0" = none)
// Returns: 1
export const ENQUEUE_DELAYED = `
local jobKey = ARGV[1] .. ARGV[2]
local dataKey = jobKey .. ':data'

local ts = tonumber(ARGV[4])
local delay = tonumber(ARGV[6])
local score = ts + delay

redis.call('HSET', jobKey,
  'ts', ARGV[4],
  'delay', ARGV[6],
  '_v', ARGV[5],
  'attempt', 1,
  'maxAttempts', ARGV[8],
  'state', 'delayed',
  'priority', ARGV[7])

if tonumber(ARGV[9]) > 0 then
  redis.call('HSET', jobKey, 'expireAt', ARGV[9])
end
if ARGV[10] ~= '' then
  redis.call('HSET', jobKey, 'concurrencyKey', ARGV[10], 'concurrencyLimit', ARGV[11])
end

redis.call('SET', dataKey, ARGV[3])
redis.call('ZADD', KEYS[1], score, ARGV[2])
redis.call('ZADD', KEYS[3], 'LT', score, '0')

redis.call('XADD', KEYS[2], 'MAXLEN', '~', 10000, '*',
  'event', 'delayed', 'jobId', ARGV[2])

return 1
`;

// ── moveToActive ─────────────────────────────────────────────────────
// KEYS[1] = <task>:wait
// KEYS[2] = <task>:active
// KEYS[3] = <task>:delayed
// KEYS[4] = <task>:events
// KEYS[5] = <task>:marker
// KEYS[6] = <task>:expired    (sorted set, score = finishedOn)
// ARGV[1] = jobPrefix
// ARGV[2] = lock TTL (ms)
// ARGV[3] = lock token (UUID)
// ARGV[4] = current timestamp (ms)
// ARGV[5] = onExpire ("fail" | "discard")
// ARGV[6] = singleton ("0" | "1")
// Returns: {id, data, _v, attempt, ts} or nil
export const MOVE_TO_ACTIVE = `
local prefix = ARGV[1]
local lockTtl = ARGV[2]
local token = ARGV[3]
local now = tonumber(ARGV[4])
local onExpire = ARGV[5]
local singleton = tonumber(ARGV[6])

-- Promote delayed jobs whose due time <= now (up to 100)
local delayed = redis.call('ZRANGEBYSCORE', KEYS[3], 0, now, 'LIMIT', 0, 100)
if #delayed > 0 then
  redis.call('ZREM', KEYS[3], unpack(delayed))
  for i = #delayed, 1, -1 do
    local jid = delayed[i]
    local jKey = prefix .. jid
    -- TTL check during promotion
    local ea = tonumber(redis.call('HGET', jKey, 'expireAt') or '0')
    if ea > 0 and now >= ea then
      if onExpire == 'discard' then
        redis.call('DEL', jKey, jKey .. ':data')
      else
        redis.call('HSET', jKey, 'state', 'expired', 'finishedOn', tostring(now))
        redis.call('ZADD', KEYS[6], now, jid)
      end
      redis.call('XADD', KEYS[4], 'MAXLEN', '~', 10000, '*',
        'event', 'expired', 'jobId', jid)
    else
      local pMeta = redis.call('HMGET', jKey, 'priority', 'ts')
      local pScore = -(tonumber(pMeta[1]) or 0) * 1e13 + (tonumber(pMeta[2]) or 0)
      redis.call('ZADD', KEYS[1], pScore, jid)
      redis.call('HSET', jKey, 'state', 'waiting')
      redis.call('XADD', KEYS[4], 'MAXLEN', '~', 10000, '*',
        'event', 'promoted', 'jobId', jid)
    end
  end
end

-- Singleton check: only one active job at a time
if singleton == 1 then
  local activeLen = redis.call('LLEN', KEYS[2])
  if activeLen > 0 then
    redis.call('ZADD', KEYS[5], now + 1000, '0')
    return nil
  end
end

-- Try to claim a job (loop for TTL/concurrency filtering, up to 100)
for _attempt = 1, 100 do
  -- ZPOPMIN returns { member, score } — take the highest-priority job.
  local popped = redis.call('ZPOPMIN', KEYS[1], 1)
  if #popped == 0 then break end
  local id = popped[1]

  local jobKey = prefix .. id
  local claimed = false

  -- TTL check
  local ea = tonumber(redis.call('HGET', jobKey, 'expireAt') or '0')
  if ea > 0 and now >= ea then
    if onExpire == 'discard' then
      redis.call('DEL', jobKey, jobKey .. ':data')
    else
      redis.call('HSET', jobKey, 'state', 'expired', 'finishedOn', tostring(now))
      redis.call('ZADD', KEYS[6], now, id)
    end
    redis.call('XADD', KEYS[4], 'MAXLEN', '~', 10000, '*',
      'event', 'expired', 'jobId', id)
  else
    -- Concurrency per key check
    local blocked = false
    local concKey = redis.call('HGET', jobKey, 'concurrencyKey')
    if concKey and concKey ~= '' then
      local concLimit = tonumber(redis.call('HGET', jobKey, 'concurrencyLimit') or '0')
      if concLimit > 0 then
        local counterKey = prefix .. 'conc:' .. concKey
        local current = tonumber(redis.call('GET', counterKey) or '0')
        if current >= concLimit then
          blocked = true
          -- Put back at the TAIL of the blocked priority band: use
          -- \`now\` instead of the original \`ts\` so the next ZPOPMIN
          -- in the same moveToActive loop pops a DIFFERENT job and
          -- doesnt immediately re-pop the blocked one (which would
          -- spin the up-to-100 retry loop until it gives up). Matches
          -- the old LIST-based LPUSH-head+RPOP-tail put-back.
          local blockedPrio = tonumber(redis.call('HGET', jobKey, 'priority') or '0')
          local blockedScore = -(blockedPrio) * 1e13 + now
          redis.call('ZADD', KEYS[1], blockedScore, id)
        else
          redis.call('INCR', counterKey)
        end
      end
    end

    if not blocked then
      -- Claim the job
      redis.call('LPUSH', KEYS[2], id)
      local lockKey = jobKey .. ':lock'
      local dataKey = jobKey .. ':data'

      redis.call('SET', lockKey, token, 'PX', lockTtl)
      redis.call('HSET', jobKey, 'state', 'active', 'processedOn', tostring(now))

      -- Collect drain: if this is a flush sentinel, drain the buffer into :data
      local skipCollect = false
      local ck = redis.call('HGET', jobKey, 'collectKey')
      if ck then
        local cItemsKey = prefix .. 'collect:' .. ck .. ':items'
        local cMetaKey  = prefix .. 'collect:' .. ck .. ':meta'
        local cFlushKey = prefix .. 'collect:' .. ck .. ':job'
        local cItems = redis.call('LRANGE', cItemsKey, 0, -1)
        if #cItems == 0 then
          -- Already flushed (race) — unclaim and skip
          redis.call('LREM', KEYS[2], 1, id)
          redis.call('DEL', jobKey, jobKey .. ':data', lockKey)
          skipCollect = true
        else
          local arr = '[' .. table.concat(cItems, ',') .. ']'
          redis.call('SET', jobKey .. ':data', arr)
          redis.call('DEL', cItemsKey, cMetaKey, cFlushKey)
          -- Clear collectKey so retries don't try to drain again
          redis.call('HDEL', jobKey, 'collectKey')
        end
      end

      if not skipCollect then
        local data = redis.call('GET', dataKey)
        local meta = redis.call('HMGET', jobKey, '_v', 'attempt', 'ts')

        redis.call('XADD', KEYS[4], 'MAXLEN', '~', 10000, '*',
          'event', 'active', 'jobId', id)

        -- Re-add marker if more work exists
        local waitLen = redis.call('ZCARD', KEYS[1])
        if waitLen > 0 then
          redis.call('ZADD', KEYS[5], 0, '0')
        else
          local nx = redis.call('ZRANGEBYSCORE', KEYS[3], 0, '+inf', 'LIMIT', 0, 1, 'WITHSCORES')
          if #nx > 0 then
            redis.call('ZADD', KEYS[5], nx[2], '0')
          end
        end

        return {id, data, meta[1], meta[2], meta[3]}
      end
    end
  end
end

-- No claimable job found
local waitLen = redis.call('ZCARD', KEYS[1])
if waitLen > 0 then
  redis.call('ZADD', KEYS[5], now + 1000, '0')
else
  local nx = redis.call('ZRANGEBYSCORE', KEYS[3], 0, '+inf', 'LIMIT', 0, 1, 'WITHSCORES')
  if #nx > 0 then
    redis.call('ZADD', KEYS[5], nx[2], '0')
  end
end
return nil
`;

// ── ack ──────────────────────────────────────────────────────────────
// KEYS[1] = <task>:active
// KEYS[2] = <task>:completed  (sorted set, score = finishedOn)
// KEYS[3] = <task>:events
// KEYS[4] = <task>:marker     (sorted set — wake workers for singleton/concurrency)
// ARGV[1] = jobPrefix
// ARGV[2] = jobId
// ARGV[3] = lock token
// ARGV[4] = serialized result
// ARGV[5] = current timestamp
// Returns: 1 or error
export const ACK = `
local prefix = ARGV[1]
local jobId = ARGV[2]
local token = ARGV[3]
local result = ARGV[4]
local now = ARGV[5]

local jobKey = prefix .. jobId
local lockKey = jobKey .. ':lock'
local resultKey = jobKey .. ':result'

-- Verify lock ownership
local lockVal = redis.call('GET', lockKey)
if lockVal ~= token then
  return redis.error_reply('LOCK_MISMATCH')
end

redis.call('LREM', KEYS[1], 1, jobId)
redis.call('DEL', lockKey)
redis.call('SET', resultKey, result)
redis.call('HSET', jobKey, 'state', 'completed', 'finishedOn', now)
redis.call('ZADD', KEYS[2], tonumber(now), jobId)

-- Clean dedup key if present
local dedupKey = redis.call('HGET', jobKey, 'dedupKey')
if dedupKey then
  redis.call('DEL', dedupKey)
end

-- Concurrency per key: decrement counter, wake workers
local concKey = redis.call('HGET', jobKey, 'concurrencyKey')
if concKey and concKey ~= '' then
  local counterKey = prefix .. 'conc:' .. concKey
  local val = redis.call('DECR', counterKey)
  if val <= 0 then
    redis.call('DEL', counterKey)
  end
  redis.call('ZADD', KEYS[4], 0, '0')
end

redis.call('XADD', KEYS[3], 'MAXLEN', '~', 10000, '*',
  'event', 'completed', 'jobId', jobId)

return 1
`;

// ── fail ─────────────────────────────────────────────────────────────
// KEYS[1] = <task>:active
// KEYS[2] = <task>:failed     (sorted set, score = finishedOn)
// KEYS[3] = <task>:events
// KEYS[4] = <task>:delayed    (sorted set for retry re-enqueue)
// KEYS[5] = <task>:marker
// ARGV[1] = jobPrefix
// ARGV[2] = jobId
// ARGV[3] = lock token
// ARGV[4] = error message
// ARGV[5] = current timestamp
// ARGV[6] = retryDelay (ms, -1 = permanent fail)
// Returns: 1 or error
export const FAIL = `
local prefix = ARGV[1]
local jobId = ARGV[2]
local token = ARGV[3]
local errMsg = ARGV[4]
local now = ARGV[5]
local retryDelay = tonumber(ARGV[6])

local jobKey = prefix .. jobId
local lockKey = jobKey .. ':lock'

local lockVal = redis.call('GET', lockKey)
if lockVal ~= token then
  return redis.error_reply('LOCK_MISMATCH')
end

redis.call('LREM', KEYS[1], 1, jobId)
redis.call('DEL', lockKey)

-- Concurrency per key: decrement counter, wake workers
local concKey = redis.call('HGET', jobKey, 'concurrencyKey')
if concKey and concKey ~= '' then
  local counterKey = prefix .. 'conc:' .. concKey
  local val = redis.call('DECR', counterKey)
  if val <= 0 then
    redis.call('DEL', counterKey)
  end
  redis.call('ZADD', KEYS[5], 0, '0')
end

if retryDelay >= 0 then
  local newAttempt = redis.call('HINCRBY', jobKey, 'attempt', 1)
  local score = tonumber(now) + retryDelay
  redis.call('HSET', jobKey, 'state', 'retrying', 'error', errMsg)
  redis.call('ZADD', KEYS[4], score, jobId)
  redis.call('ZADD', KEYS[5], 'LT', score, '0')

  redis.call('XADD', KEYS[3], 'MAXLEN', '~', 10000, '*',
    'event', 'retrying', 'jobId', jobId,
    'attempt', tostring(newAttempt), 'nextAttemptAt', tostring(score))
else
  redis.call('HSET', jobKey, 'state', 'failed', 'finishedOn', now, 'error', errMsg)
  redis.call('ZADD', KEYS[2], tonumber(now), jobId)

  -- Clean dedup key on permanent failure
  local dedupKey = redis.call('HGET', jobKey, 'dedupKey')
  if dedupKey then
    redis.call('DEL', dedupKey)
  end

  redis.call('XADD', KEYS[3], 'MAXLEN', '~', 10000, '*',
    'event', 'failed', 'jobId', jobId)
end

return 1
`;

// ── nack ─────────────────────────────────────────────────────────────
// KEYS[1] = <task>:active
// KEYS[2] = <task>:wait
// KEYS[3] = <task>:events
// KEYS[4] = <task>:marker
// ARGV[1] = jobPrefix
// ARGV[2] = jobId
// ARGV[3] = lock token
// Returns: 1 or error
export const NACK = `
local prefix = ARGV[1]
local jobId = ARGV[2]
local token = ARGV[3]

local jobKey = prefix .. jobId
local lockKey = jobKey .. ':lock'

local lockVal = redis.call('GET', lockKey)
if lockVal ~= token then
  return redis.error_reply('LOCK_MISMATCH')
end

redis.call('LREM', KEYS[1], 1, jobId)
redis.call('DEL', lockKey)

-- Concurrency per key: decrement counter
local concKey = redis.call('HGET', jobKey, 'concurrencyKey')
if concKey and concKey ~= '' then
  local counterKey = prefix .. 'conc:' .. concKey
  local val = redis.call('DECR', counterKey)
  if val <= 0 then
    redis.call('DEL', counterKey)
  end
end

redis.call('HSET', jobKey, 'state', 'waiting')
local nMeta = redis.call('HMGET', jobKey, 'priority', 'ts')
local nScore = -(tonumber(nMeta[1]) or 0) * 1e13 + (tonumber(nMeta[2]) or 0)
redis.call('ZADD', KEYS[2], nScore, jobId)
redis.call('ZADD', KEYS[4], 0, '0')

redis.call('XADD', KEYS[3], 'MAXLEN', '~', 10000, '*',
  'event', 'waiting', 'jobId', jobId)

return 1
`;

// ── stalledCheck ────────────────────────────────────────────────
// KEYS[1] = <task>:stalled   (Set: candidate stalled IDs from last check)
// KEYS[2] = <task>:active    (List: currently active jobs)
// KEYS[3] = <task>:wait      (List: for re-queuing recovered jobs)
// KEYS[4] = <task>:failed    (Sorted Set: permanently failed jobs)
// KEYS[5] = <task>:events    (Stream)
// KEYS[6] = <task>:marker    (Sorted Set: wake workers)
// KEYS[7] = <task>:cancelled (Sorted Set: cancelled jobs)
// ARGV[1] = jobPrefix
// ARGV[2] = maxStalledCount
// ARGV[3] = current timestamp (ms)
// Returns: { recovered[], failed[] } as flat array [#recovered, ...recoveredIds, #failed, ...failedIds]
export const STALLED_CHECK = `
local prefix = ARGV[1]
local maxStalled = tonumber(ARGV[2])
local now = ARGV[3]

local recovered = {}
local failed = {}

-- Phase 1: Resolve candidates from last check
local candidates = redis.call('SMEMBERS', KEYS[1])

for _, jobId in ipairs(candidates) do
  local lockKey = prefix .. jobId .. ':lock'
  local exists = redis.call('EXISTS', lockKey)

  if exists == 0 then
    local jobKey = prefix .. jobId

    -- If job was flagged for cancellation, move to cancelled instead of recovering
    local cancelledAt = redis.call('HGET', jobKey, 'cancelledAt')
    if cancelledAt then
      redis.call('LREM', KEYS[2], 1, jobId)

      -- Concurrency per key cleanup
      local concKey = redis.call('HGET', jobKey, 'concurrencyKey')
      if concKey and concKey ~= '' then
        local counterKey = prefix .. 'conc:' .. concKey
        local val = redis.call('DECR', counterKey)
        if val <= 0 then
          redis.call('DEL', counterKey)
        end
      end

      local reason = redis.call('HGET', jobKey, 'cancelReason') or ''
      redis.call('HSET', jobKey, 'state', 'cancelled', 'finishedOn', now)
      redis.call('ZADD', KEYS[7], tonumber(now), jobId)

      -- Clean dedup key
      local dedupKey = redis.call('HGET', jobKey, 'dedupKey')
      if dedupKey then
        redis.call('DEL', dedupKey)
      end

      redis.call('XADD', KEYS[5], 'MAXLEN', '~', 10000, '*',
        'event', 'cancelled', 'jobId', jobId, 'reason', reason)

      redis.call('SREM', KEYS[1], jobId)
    else
      local count = redis.call('HINCRBY', jobKey, 'stalledCount', 1)

      -- Concurrency per key: decrement counter (job leaving active)
      local concKey = redis.call('HGET', jobKey, 'concurrencyKey')
      if concKey and concKey ~= '' then
        local counterKey = prefix .. 'conc:' .. concKey
        local val = redis.call('DECR', counterKey)
        if val <= 0 then
          redis.call('DEL', counterKey)
        end
      end

      if count > maxStalled then
        -- Permanently fail
        redis.call('LREM', KEYS[2], 1, jobId)
        redis.call('HSET', jobKey, 'state', 'failed', 'finishedOn', now,
          'error', 'Job stalled and exceeded max stalled count')
        redis.call('ZADD', KEYS[4], tonumber(now), jobId)

        redis.call('XADD', KEYS[5], 'MAXLEN', '~', 10000, '*',
          'event', 'stalled', 'jobId', jobId,
          'count', tostring(count), 'action', 'failed')

        redis.call('XADD', KEYS[5], 'MAXLEN', '~', 10000, '*',
          'event', 'failed', 'jobId', jobId)

        table.insert(failed, jobId)
      else
        -- Recover: move back to wait
        redis.call('LREM', KEYS[2], 1, jobId)
        redis.call('HSET', jobKey, 'state', 'waiting')
        local sMeta = redis.call('HMGET', jobKey, 'priority', 'ts')
        local sScore = -(tonumber(sMeta[1]) or 0) * 1e13 + (tonumber(sMeta[2]) or 0)
        redis.call('ZADD', KEYS[3], sScore, jobId)
        redis.call('ZADD', KEYS[6], 0, '0')

        redis.call('XADD', KEYS[5], 'MAXLEN', '~', 10000, '*',
          'event', 'stalled', 'jobId', jobId,
          'count', tostring(count), 'action', 'recovered')

        table.insert(recovered, jobId)
      end

      redis.call('SREM', KEYS[1], jobId)
    end
  end
end

-- Phase 2: Copy all current active IDs into stalled set for next check
local activeIds = redis.call('LRANGE', KEYS[2], 0, -1)
if #activeIds > 0 then
  redis.call('SADD', KEYS[1], unpack(activeIds))
end

-- Return flat: [#recovered, ...ids, #failed, ...ids]
local result = { #recovered }
for _, id in ipairs(recovered) do
  table.insert(result, id)
end
table.insert(result, #failed)
for _, id in ipairs(failed) do
  table.insert(result, id)
end

return result
`;

// ── extendLock ───────────────────────────────────────────────────────
// KEYS[1] = <task>:stalled   (stalled set — prepared for Phase 7)
// ARGV[1] = jobPrefix
// ARGV[2] = jobId
// ARGV[3] = lock token
// ARGV[4] = lock TTL (ms)
// Returns: 1 (extended) or 0 (lock mismatch)
export const EXTEND_LOCK = `
local prefix = ARGV[1]
local jobId = ARGV[2]
local token = ARGV[3]
local ttl = ARGV[4]

local lockKey = prefix .. jobId .. ':lock'

local lockVal = redis.call('GET', lockKey)
if lockVal ~= token then
  return 0
end

redis.call('SET', lockKey, token, 'PX', ttl)
redis.call('SREM', KEYS[1], jobId)

-- Check cancel flag
local cancelled = redis.call('HGET', prefix .. jobId, 'cancelledAt')
if cancelled then
  return -1
end

return 1
`;

// ── tickScheduler ───────────────────────────────────────────────────
// Atomically claim all due schedules: ZRANGEBYSCORE + ZREM + HGET configs.
// The caller (TypeScript) dispatches tasks and ZADDs the next run time.
// KEYS[1] = schedules:next   (Sorted Set: name → next run timestamp)
// KEYS[2] = schedules        (Hash: name → JSON config)
// ARGV[1] = current timestamp (ms)
// Returns: flat array [name1, config1, name2, config2, ...]
export const TICK_SCHEDULER = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1])
if #due == 0 then
  return {}
end

local results = {}
for _, name in ipairs(due) do
  local cfg = redis.call('HGET', KEYS[2], name)
  if cfg then
    table.insert(results, name)
    table.insert(results, cfg)
  end
  redis.call('ZREM', KEYS[1], name)
end

return results
`;

// ── acquireSchedulerLock ────────────────────────────────────────────
// SET NX PX — only succeeds if no lock exists.
// KEYS[1] = schedules:lock
// ARGV[1] = token (UUID)
// ARGV[2] = TTL (ms)
// Returns: 1 (acquired) or 0
export const ACQUIRE_SCHEDULER_LOCK = `
local ok = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2])
if ok then
  return 1
end
return 0
`;

// ── renewSchedulerLock ──────────────────────────────────────────────
// Only renew if we own the lock (token matches).
// KEYS[1] = schedules:lock
// ARGV[1] = token (UUID)
// ARGV[2] = TTL (ms)
// Returns: 1 (renewed) or 0 (lost)
export const RENEW_SCHEDULER_LOCK = `
local val = redis.call('GET', KEYS[1])
if val == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
end
return 0
`;

// ── versionDistribution ─────────────────────────────────────────────
// Collect _v counts for all jobs in waiting, active, and delayed sets.
// KEYS[1] = <task>:wait      (List)
// KEYS[2] = <task>:active    (List)
// KEYS[3] = <task>:delayed   (Sorted Set)
// ARGV[1] = jobPrefix
// Returns: flat array [section, version, count, ..., "END", section, ...]
export const VERSION_DISTRIBUTION = `
local prefix = ARGV[1]

local function countVersions(ids)
  local counts = {}
  for _, id in ipairs(ids) do
    local v = redis.call('HGET', prefix .. id, '_v')
    if v then
      v = tostring(v)
      counts[v] = (counts[v] or 0) + 1
    end
  end
  local result = {}
  for v, c in pairs(counts) do
    table.insert(result, v)
    table.insert(result, c)
  end
  return result
end

local result = {}

-- Waiting (wait list is a ZSET)
local waitIds = redis.call('ZRANGE', KEYS[1], 0, -1)
table.insert(result, 'waiting')
local wv = countVersions(waitIds)
for _, x in ipairs(wv) do table.insert(result, x) end
table.insert(result, 'END')

-- Active
local activeIds = redis.call('LRANGE', KEYS[2], 0, -1)
table.insert(result, 'active')
local av = countVersions(activeIds)
for _, x in ipairs(av) do table.insert(result, x) end
table.insert(result, 'END')

-- Delayed
local delayedIds = redis.call('ZRANGE', KEYS[3], 0, -1)
table.insert(result, 'delayed')
local dv = countVersions(delayedIds)
for _, x in ipairs(dv) do table.insert(result, x) end
table.insert(result, 'END')

return result
`;

// ── listJobDetails ──────────────────────────────────────────────────
// Fetch job IDs from a queue + all details in one script (1 RTT).
// KEYS[1] = queue key (wait/active/delayed/completed/failed)
// ARGV[1] = jobPrefix
// ARGV[2] = offset
// ARGV[3] = limit
// ARGV[4] = mode: "lrange" | "zrange" | "zrevrange"
// Returns: nested array — each entry is [id, ts, _v, attempt, state,
//   processedOn, finishedOn, error, progress, data, result, numLogs, ...logs]
export const LIST_JOB_DETAILS = `
local prefix = ARGV[1]
local offset = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local mode = ARGV[4]

local ids
if mode == 'wait_zrange' then
  -- Wait list is a sorted set keyed by the composite (priority, ts)
  -- score. ZRANGE gives the dequeue order directly (highest priority
  -- first, FIFO within the same priority).
  ids = redis.call('ZRANGE', KEYS[1], offset, offset + limit - 1)
elseif mode == 'lrange' then
  -- Active list is still a LIST (LPUSH-ordered, newest at head). Sort by
  -- ts for a deterministic chronological view regardless of driver.
  local all = redis.call('LRANGE', KEYS[1], 0, -1)
  local sortable = {}
  for i = 1, #all do
    local ts = tonumber(redis.call('HGET', prefix .. all[i], 'ts') or '0')
    sortable[#sortable + 1] = { all[i], ts }
  end
  table.sort(sortable, function(a, b) return a[2] < b[2] end)
  ids = {}
  local from = offset + 1
  local to = math.min(#sortable, offset + limit)
  for i = from, to do ids[#ids + 1] = sortable[i][1] end
elseif mode == 'zrange' then
  ids = redis.call('ZRANGE', KEYS[1], offset, offset + limit - 1)
else
  ids = redis.call('ZREVRANGE', KEYS[1], offset, offset + limit - 1)
end

if #ids == 0 then
  return {}
end

local result = {}
for _, jobId in ipairs(ids) do
  local jobKey = prefix .. jobId
  local meta = redis.call('HMGET', jobKey,
    'ts', '_v', 'attempt', 'state', 'processedOn', 'finishedOn', 'error', 'progress')

  if meta[4] then
    local entry = { jobId }
    for i = 1, 8 do
      entry[i + 1] = meta[i] or false
    end
    entry[10] = redis.call('GET', jobKey .. ':data') or false
    entry[11] = redis.call('GET', jobKey .. ':result') or false
    local logs = redis.call('LRANGE', jobKey .. ':logs', 0, -1)
    entry[12] = #logs
    for i = 1, #logs do
      entry[12 + i] = logs[i]
    end
    result[#result + 1] = entry
  end
end

return result
`;

// ── retryDLQ ────────────────────────────────────────────────────────
// Atomically move a single job from failed back to waiting.
// KEYS[1] = <task>:failed    (sorted set)
// KEYS[2] = <task>:wait      (sorted set)
// KEYS[3] = <task>:events    (stream)
// KEYS[4] = <task>:marker    (sorted set)
// ARGV[1] = jobPrefix
// ARGV[2] = jobId
// ARGV[3] = now (ms) — fresh ts for the recovered job's wait score
// Returns: 1 (retried) or 0 (not found in failed)
export const RETRY_DLQ = `
local prefix = ARGV[1]
local jobId = ARGV[2]
local jobKey = prefix .. jobId

local removed = redis.call('ZREM', KEYS[1], jobId)
if removed == 0 then
  return 0
end

redis.call('HSET', jobKey, 'state', 'waiting', 'attempt', 1)
redis.call('HDEL', jobKey, 'error', 'finishedOn')
redis.call('DEL', prefix .. jobId .. ':result')
-- Recovered DLQ jobs re-enter with a fresh ts so they land at the tail
-- of their priority band (vs. keeping their original ts and potentially
-- cutting ahead of jobs enqueued while they sat in :failed).
redis.call('HSET', jobKey, 'ts', ARGV[3])
local rPrio = tonumber(redis.call('HGET', jobKey, 'priority') or '0')
local rScore = -(rPrio) * 1e13 + tonumber(ARGV[3])
redis.call('ZADD', KEYS[2], rScore, jobId)
redis.call('ZADD', KEYS[4], 0, '0')

redis.call('XADD', KEYS[3], 'MAXLEN', '~', 10000, '*',
  'event', 'waiting', 'jobId', jobId)

return 1
`;

// ── retryAllDLQ ─────────────────────────────────────────────────────
// Atomically move a batch of failed jobs back to waiting.
// KEYS[1] = <task>:failed
// KEYS[2] = <task>:wait
// KEYS[3] = <task>:events
// KEYS[4] = <task>:marker
// ARGV[1] = jobPrefix
// ARGV[2] = limit (max jobs to retry per call)
// ARGV[3] = now (ms) — fresh ts for recovered jobs' wait score
// Returns: number of jobs retried
export const RETRY_ALL_DLQ = `
local prefix = ARGV[1]
local limit = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local ids = redis.call('ZRANGE', KEYS[1], 0, limit - 1)
if #ids == 0 then
  return 0
end

for _, jobId in ipairs(ids) do
  local jobKey = prefix .. jobId
  redis.call('ZREM', KEYS[1], jobId)
  redis.call('HSET', jobKey, 'state', 'waiting', 'attempt', 1, 'ts', ARGV[3])
  redis.call('HDEL', jobKey, 'error', 'finishedOn')
  redis.call('DEL', prefix .. jobId .. ':result')
  local bPrio = tonumber(redis.call('HGET', jobKey, 'priority') or '0')
  local bScore = -(bPrio) * 1e13 + now
  redis.call('ZADD', KEYS[2], bScore, jobId)

  redis.call('XADD', KEYS[3], 'MAXLEN', '~', 10000, '*',
    'event', 'waiting', 'jobId', jobId)
end

redis.call('ZADD', KEYS[4], 0, '0')
return #ids
`;

// ── trimDLQ ─────────────────────────────────────────────────────────
// Two-phase trim: (1) remove jobs older than cutoff, (2) cap total at maxItems.
// KEYS[1] = <task>:failed
// ARGV[1] = jobPrefix
// ARGV[2] = cutoff timestamp (ms) — jobs with score <= cutoff are removed
// ARGV[3] = maxItems — max number of failed jobs to keep (0 = no cap)
// Returns: total number of jobs trimmed
export const TRIM_DLQ = `
local prefix = ARGV[1]
local cutoff = tonumber(ARGV[2])
local maxItems = tonumber(ARGV[3])
local trimmed = 0

-- Phase 1: age-based trim (oldest first, batch of 100)
if cutoff > 0 then
  local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', cutoff, 'LIMIT', 0, 100)
  for _, jobId in ipairs(ids) do
    redis.call('ZREM', KEYS[1], jobId)
    local jobKey = prefix .. jobId
    redis.call('DEL', jobKey,
      jobKey .. ':data',
      jobKey .. ':result',
      jobKey .. ':lock',
      jobKey .. ':logs')
    trimmed = trimmed + 1
  end
end

-- Phase 2: count-based trim (evict oldest when over cap, batch of 100)
if maxItems > 0 then
  local total = redis.call('ZCARD', KEYS[1])
  if total > maxItems then
    local excess = math.min(total - maxItems, 100)
    local ids = redis.call('ZRANGE', KEYS[1], 0, excess - 1)
    for _, jobId in ipairs(ids) do
      redis.call('ZREM', KEYS[1], jobId)
      local jobKey = prefix .. jobId
      redis.call('DEL', jobKey,
        jobKey .. ':data',
        jobKey .. ':result',
        jobKey .. ':lock',
        jobKey .. ':logs')
      trimmed = trimmed + 1
    end
  end
end

return trimmed
`;

// ── debounce ────────────────────────────────────────────────────────
// Atomically replace a previous debounced delayed job with a new one.
// KEYS[1] = <task>:delayed   (sorted set)
// KEYS[2] = <task>:events    (stream)
// KEYS[3] = <task>:marker    (sorted set)
// ARGV[1] = jobPrefix
// ARGV[2] = jobId            (new job UUID)
// ARGV[3] = serialized data
// ARGV[4] = timestamp (ms)
// ARGV[5] = _v
// ARGV[6] = delay (ms)       — the debounce window
// ARGV[7] = priority
// ARGV[8] = maxAttempts
// ARGV[9] = debounce key     (full Redis key)
// ARGV[10] = expireAt (0 = no TTL)
// ARGV[11] = concurrencyKey ("" = none)
// ARGV[12] = concurrencyLimit ("0" = none)
// Returns: 1
export const DEBOUNCE = `
local prefix = ARGV[1]
local jobId = ARGV[2]
local data = ARGV[3]
local ts = tonumber(ARGV[4])
local version = ARGV[5]
local delay = tonumber(ARGV[6])
local priority = ARGV[7]
local maxAttempts = ARGV[8]
local debounceKey = ARGV[9]

local score = ts + delay

-- Check for existing debounced job
local oldJobId = redis.call('GET', debounceKey)
if oldJobId then
  local removed = redis.call('ZREM', KEYS[1], oldJobId)
  if removed > 0 then
    local oldJobKey = prefix .. oldJobId
    redis.call('DEL', oldJobKey, oldJobKey .. ':data')
    redis.call('XADD', KEYS[2], 'MAXLEN', '~', 10000, '*',
      'event', 'debounced', 'jobId', oldJobId, 'replacedBy', jobId)
  end
end

-- Create new delayed job
local jobKey = prefix .. jobId
local dataKey = jobKey .. ':data'

redis.call('HSET', jobKey,
  'ts', ARGV[4],
  'delay', ARGV[6],
  '_v', version,
  'attempt', 1,
  'maxAttempts', maxAttempts,
  'state', 'delayed',
  'priority', priority)

if tonumber(ARGV[10]) > 0 then
  redis.call('HSET', jobKey, 'expireAt', ARGV[10])
end
if ARGV[11] ~= '' then
  redis.call('HSET', jobKey, 'concurrencyKey', ARGV[11], 'concurrencyLimit', ARGV[12])
end

redis.call('SET', dataKey, data)
redis.call('ZADD', KEYS[1], score, jobId)
redis.call('ZADD', KEYS[3], 'LT', score, '0')

-- Set debounce key -> new jobId with TTL = delay * 2 (self-cleaning)
redis.call('SET', debounceKey, jobId, 'PX', delay * 2)

redis.call('XADD', KEYS[2], 'MAXLEN', '~', 10000, '*',
  'event', 'delayed', 'jobId', jobId)

return 1
`;

// ── throttleEnqueue ─────────────────────────────────────────────────
// Atomically check throttle counter and enqueue if under limit.
// KEYS[1] = <task>:wait      (wait list)
// KEYS[2] = <task>:delayed   (sorted set — for delayed jobs)
// KEYS[3] = <task>:events    (stream)
// KEYS[4] = <task>:marker    (sorted set)
// ARGV[1]  = jobPrefix
// ARGV[2]  = jobId
// ARGV[3]  = serialized data
// ARGV[4]  = timestamp (ms)
// ARGV[5]  = _v
// ARGV[6]  = priority
// ARGV[7]  = maxAttempts
// ARGV[8]  = throttle key    (full Redis key)
// ARGV[9]  = max             (max dispatches per window)
// ARGV[10] = window (ms)
// ARGV[11] = delay (ms, 0 = immediate)
// ARGV[12] = expireAt (0 = no TTL)
// ARGV[13] = concurrencyKey ("" = none)
// ARGV[14] = concurrencyLimit ("0" = none)
// Returns: 1 (enqueued) or 0 (throttled)
export const THROTTLE_ENQUEUE = `
local prefix = ARGV[1]
local jobId = ARGV[2]
local data = ARGV[3]
local ts = tonumber(ARGV[4])
local version = ARGV[5]
local priority = ARGV[6]
local maxAttempts = ARGV[7]
local throttleKey = ARGV[8]
local max = tonumber(ARGV[9])
local window = tonumber(ARGV[10])
local delay = tonumber(ARGV[11])

-- Check throttle counter
local current = tonumber(redis.call('GET', throttleKey) or '0')
if current >= max then
  return 0
end

-- Increment counter (set TTL on first increment)
if current == 0 then
  redis.call('SET', throttleKey, 1, 'PX', window)
else
  redis.call('INCR', throttleKey)
end

-- Enqueue the job
local jobKey = prefix .. jobId
local dataKey = jobKey .. ':data'

if delay > 0 then
  local score = ts + delay
  redis.call('HSET', jobKey,
    'ts', ARGV[4],
    'delay', ARGV[11],
    '_v', version,
    'attempt', 1,
    'maxAttempts', maxAttempts,
    'state', 'delayed',
    'priority', priority)
  redis.call('SET', dataKey, data)
  redis.call('ZADD', KEYS[2], score, jobId)
  redis.call('ZADD', KEYS[4], 'LT', score, '0')
  redis.call('XADD', KEYS[3], 'MAXLEN', '~', 10000, '*',
    'event', 'delayed', 'jobId', jobId)
else
  redis.call('HSET', jobKey,
    'ts', ARGV[4],
    '_v', version,
    'attempt', 1,
    'maxAttempts', maxAttempts,
    'state', 'waiting',
    'priority', priority)
  redis.call('SET', dataKey, data)
  local tScore = -(tonumber(priority) or 0) * 1e13 + ts
  redis.call('ZADD', KEYS[1], tScore, jobId)
  redis.call('ZADD', KEYS[4], 0, '0')
  redis.call('XADD', KEYS[3], 'MAXLEN', '~', 10000, '*',
    'event', 'waiting', 'jobId', jobId)
end

if tonumber(ARGV[12]) > 0 then
  redis.call('HSET', jobKey, 'expireAt', ARGV[12])
end
if ARGV[13] ~= '' then
  redis.call('HSET', jobKey, 'concurrencyKey', ARGV[13], 'concurrencyLimit', ARGV[14])
end

return 1
`;

// ── deduplicateEnqueue ──────────────────────────────────────────────
// Atomically check dedup key + existing job state, enqueue if no dupe.
// KEYS[1] = <task>:wait      (wait list)
// KEYS[2] = <task>:delayed   (sorted set)
// KEYS[3] = <task>:events    (stream)
// KEYS[4] = <task>:marker    (sorted set)
// ARGV[1]  = jobPrefix
// ARGV[2]  = jobId
// ARGV[3]  = serialized data
// ARGV[4]  = timestamp (ms)
// ARGV[5]  = _v
// ARGV[6]  = priority
// ARGV[7]  = maxAttempts
// ARGV[8]  = dedup key       (full Redis key)
// ARGV[9]  = delay (ms, 0 = immediate)
// ARGV[10] = expireAt (0 = no TTL)
// ARGV[11] = concurrencyKey ("" = none)
// ARGV[12] = concurrencyLimit ("0" = none)
// ARGV[13+] = allowed states (e.g. "waiting", "delayed", "active")
// Returns: [1] (created) or [0, existingJobId] (duplicate found)
export const DEDUPLICATE_ENQUEUE = `
local prefix = ARGV[1]
local jobId = ARGV[2]
local data = ARGV[3]
local ts = tonumber(ARGV[4])
local version = ARGV[5]
local priority = ARGV[6]
local maxAttempts = ARGV[7]
local dedupKey = ARGV[8]
local delay = tonumber(ARGV[9])

-- Collect allowed states (after flow control args)
local allowedStates = {}
for i = 13, #ARGV do
  allowedStates[ARGV[i]] = true
end

-- Check dedup key
local existingId = redis.call('GET', dedupKey)
if existingId then
  local existingState = redis.call('HGET', prefix .. existingId, 'state')
  if existingState and allowedStates[existingState] then
    return {0, existingId}
  end
  -- Existing job in non-blocking state (completed/failed) — clear and proceed
  redis.call('DEL', dedupKey)
end

-- Enqueue the job
local jobKey = prefix .. jobId
local dataKey = jobKey .. ':data'

if delay > 0 then
  local score = ts + delay
  redis.call('HSET', jobKey,
    'ts', ARGV[4],
    'delay', ARGV[9],
    '_v', version,
    'attempt', 1,
    'maxAttempts', maxAttempts,
    'state', 'delayed',
    'priority', priority,
    'dedupKey', dedupKey)
  redis.call('SET', dataKey, data)
  redis.call('ZADD', KEYS[2], score, jobId)
  redis.call('ZADD', KEYS[4], 'LT', score, '0')
  redis.call('XADD', KEYS[3], 'MAXLEN', '~', 10000, '*',
    'event', 'delayed', 'jobId', jobId)
else
  redis.call('HSET', jobKey,
    'ts', ARGV[4],
    '_v', version,
    'attempt', 1,
    'maxAttempts', maxAttempts,
    'state', 'waiting',
    'priority', priority,
    'dedupKey', dedupKey)
  redis.call('SET', dataKey, data)
  local dScore = -(tonumber(priority) or 0) * 1e13 + ts
  redis.call('ZADD', KEYS[1], dScore, jobId)
  redis.call('ZADD', KEYS[4], 0, '0')
  redis.call('XADD', KEYS[3], 'MAXLEN', '~', 10000, '*',
    'event', 'waiting', 'jobId', jobId)
end

if tonumber(ARGV[10]) > 0 then
  redis.call('HSET', jobKey, 'expireAt', ARGV[10])
end
if ARGV[11] ~= '' then
  redis.call('HSET', jobKey, 'concurrencyKey', ARGV[11], 'concurrencyLimit', ARGV[12])
end

-- Set dedup key -> jobId (no TTL — cleaned on ack/fail)
redis.call('SET', dedupKey, jobId)

return {1}
`;

// ── collectPush ─────────────────────────────────────────────────────
// Accumulate an item into a collect buffer. Manages debounce flush
// sentinel in the delayed sorted set. On maxSize: immediate flush.
// KEYS[1] = <task>:delayed   (sorted set — flush sentinel lives here)
// KEYS[2] = <task>:events    (stream)
// KEYS[3] = <task>:marker    (sorted set — wakes workers)
// KEYS[4] = <task>:wait      (wait list — for maxSize immediate flush)
// ARGV[1]  = jobPrefix       (e.g. "taskora:{task}:")
// ARGV[2]  = jobId           (UUID for new flush sentinel / real job)
// ARGV[3]  = serialized item (single, already serialized by caller)
// ARGV[4]  = timestamp (ms)
// ARGV[5]  = _v
// ARGV[6]  = delayMs         (debounce window)
// ARGV[7]  = maxSize         (0 = unlimited)
// ARGV[8]  = maxWaitMs       (0 = unlimited)
// ARGV[9]  = collectKey      (the resolved key string)
// ARGV[10] = maxAttempts
// Returns: {0, count} (buffered) or {1, count} (flushed)
export const COLLECT_PUSH = `
local prefix = ARGV[1]
local jobId = ARGV[2]
local item = ARGV[3]
local now = tonumber(ARGV[4])
local version = ARGV[5]
local delayMs = tonumber(ARGV[6])
local maxSize = tonumber(ARGV[7])
local maxWaitMs = tonumber(ARGV[8])
local collectKey = ARGV[9]
local maxAttempts = ARGV[10]

local itemsKey = prefix .. 'collect:' .. collectKey .. ':items'
local metaKey  = prefix .. 'collect:' .. collectKey .. ':meta'
local flushIdKey = prefix .. 'collect:' .. collectKey .. ':job'

-- Push item to accumulator list
redis.call('RPUSH', itemsKey, item)

-- Update meta: firstAt (only on first), lastAt, count
local count = tonumber(redis.call('HINCRBY', metaKey, 'count', 1))
redis.call('HSET', metaKey, 'lastAt', tostring(now))
if count == 1 then
  redis.call('HSET', metaKey, 'firstAt', tostring(now))
end

-- Check maxSize → immediate flush
if maxSize > 0 and count >= maxSize then
  -- Remove existing flush sentinel if any
  local oldFlushId = redis.call('GET', flushIdKey)
  if oldFlushId then
    redis.call('ZREM', KEYS[1], oldFlushId)
    local oldKey = prefix .. oldFlushId
    redis.call('DEL', oldKey, oldKey .. ':data')
  end

  -- Drain buffer into a real job
  local items = redis.call('LRANGE', itemsKey, 0, -1)
  local arr = '[' .. table.concat(items, ',') .. ']'
  redis.call('DEL', itemsKey, metaKey, flushIdKey)

  local jobKey = prefix .. jobId
  redis.call('HSET', jobKey,
    'ts', ARGV[4],
    '_v', version,
    'attempt', 1,
    'maxAttempts', maxAttempts,
    'state', 'waiting',
    'priority', '0')
  redis.call('SET', jobKey .. ':data', arr)
  -- Collect flush jobs default to priority 0; score = -(0 * 1e13) + now = now.
  redis.call('ZADD', KEYS[4], now, jobId)
  redis.call('ZADD', KEYS[3], 0, '0')
  redis.call('XADD', KEYS[2], 'MAXLEN', '~', 10000, '*',
    'event', 'waiting', 'jobId', jobId)

  return {1, count}
end

-- Remove old flush sentinel (debounce reset)
local oldFlushId = redis.call('GET', flushIdKey)
if oldFlushId then
  redis.call('ZREM', KEYS[1], oldFlushId)
  local oldKey = prefix .. oldFlushId
  redis.call('DEL', oldKey, oldKey .. ':data')
end

-- Compute flush score: min(now + delay, firstAt + maxWait)
local flushScore = now + delayMs
if maxWaitMs > 0 then
  local firstAt = tonumber(redis.call('HGET', metaKey, 'firstAt'))
  local maxWaitDeadline = firstAt + maxWaitMs
  if maxWaitDeadline < flushScore then
    flushScore = maxWaitDeadline
  end
end

-- Create new flush sentinel as a delayed job
local jobKey = prefix .. jobId
redis.call('HSET', jobKey,
  'ts', ARGV[4],
  '_v', version,
  'attempt', 1,
  'maxAttempts', maxAttempts,
  'state', 'delayed',
  'collectKey', collectKey)
-- No :data yet — moveToActive will drain the buffer
redis.call('SET', jobKey .. ':data', '[]')
redis.call('ZADD', KEYS[1], flushScore, jobId)
redis.call('ZADD', KEYS[3], 'LT', flushScore, '0')
redis.call('SET', flushIdKey, jobId, 'PX', math.max(delayMs, maxWaitMs > 0 and maxWaitMs or delayMs) * 2)

redis.call('XADD', KEYS[2], 'MAXLEN', '~', 10000, '*',
  'event', 'collect', 'jobId', jobId, 'count', tostring(count), 'key', collectKey)

return {0, count}
`;

// ── cancel ──────────────────────────────────────────────────────────
// Cancel a job. Immediate for waiting/delayed/retrying; flags active + PUBLISH.
// KEYS[1] = <task>:wait
// KEYS[2] = <task>:delayed
// KEYS[3] = <task>:cancelled  (sorted set, score = finishedOn)
// KEYS[4] = <task>:events
// KEYS[5] = <task>:marker
// KEYS[6] = <task>:cancel     (pub/sub channel — instant notification to worker)
// ARGV[1] = jobPrefix
// ARGV[2] = jobId
// ARGV[3] = reason ("" = none)
// ARGV[4] = current timestamp (ms)
// Returns: 1 (cancelled immediately), 2 (active — flagged), 0 (not cancellable)
export const CANCEL = `
local prefix = ARGV[1]
local jobId = ARGV[2]
local reason = ARGV[3]
local now = ARGV[4]

local jobKey = prefix .. jobId
local state = redis.call('HGET', jobKey, 'state')

if not state then
  return 0
end

if state == 'waiting' then
  redis.call('ZREM', KEYS[1], jobId)
  redis.call('HSET', jobKey, 'state', 'cancelled', 'finishedOn', now)
  if reason ~= '' then
    redis.call('HSET', jobKey, 'cancelReason', reason)
  end
  redis.call('ZADD', KEYS[3], tonumber(now), jobId)

  -- Clean dedup key
  local dedupKey = redis.call('HGET', jobKey, 'dedupKey')
  if dedupKey then
    redis.call('DEL', dedupKey)
  end

  redis.call('XADD', KEYS[4], 'MAXLEN', '~', 10000, '*',
    'event', 'cancelled', 'jobId', jobId, 'reason', reason)
  return 1
end

if state == 'delayed' or state == 'retrying' then
  redis.call('ZREM', KEYS[2], jobId)
  redis.call('HSET', jobKey, 'state', 'cancelled', 'finishedOn', now)
  if reason ~= '' then
    redis.call('HSET', jobKey, 'cancelReason', reason)
  end
  redis.call('ZADD', KEYS[3], tonumber(now), jobId)

  -- Clean dedup key
  local dedupKey = redis.call('HGET', jobKey, 'dedupKey')
  if dedupKey then
    redis.call('DEL', dedupKey)
  end

  redis.call('XADD', KEYS[4], 'MAXLEN', '~', 10000, '*',
    'event', 'cancelled', 'jobId', jobId, 'reason', reason)
  return 1
end

if state == 'active' then
  -- Flag + instant pub/sub notification to worker
  redis.call('HSET', jobKey, 'cancelledAt', now)
  if reason ~= '' then
    redis.call('HSET', jobKey, 'cancelReason', reason)
  end
  redis.call('PUBLISH', KEYS[6], jobId)
  return 2
end

-- Terminal state (completed, failed, cancelled, expired) — can't cancel
return 0
`;

// ── finishCancel ────────────────────────────────────────────────────
// Worker calls this after onCancel hook runs to finalize active → cancelled.
// KEYS[1] = <task>:active
// KEYS[2] = <task>:cancelled  (sorted set)
// KEYS[3] = <task>:events
// KEYS[4] = <task>:marker
// ARGV[1] = jobPrefix
// ARGV[2] = jobId
// ARGV[3] = lock token
// ARGV[4] = current timestamp (ms)
// Returns: 1 or LOCK_MISMATCH error
export const FINISH_CANCEL = `
local prefix = ARGV[1]
local jobId = ARGV[2]
local token = ARGV[3]
local now = ARGV[4]

local jobKey = prefix .. jobId
local lockKey = jobKey .. ':lock'

-- Verify lock ownership
local lockVal = redis.call('GET', lockKey)
if lockVal ~= token then
  return redis.error_reply('LOCK_MISMATCH')
end

redis.call('LREM', KEYS[1], 1, jobId)
redis.call('DEL', lockKey)

local reason = redis.call('HGET', jobKey, 'cancelReason') or ''
redis.call('HSET', jobKey, 'state', 'cancelled', 'finishedOn', now)
redis.call('ZADD', KEYS[2], tonumber(now), jobId)

-- Clean dedup key
local dedupKey = redis.call('HGET', jobKey, 'dedupKey')
if dedupKey then
  redis.call('DEL', dedupKey)
end

-- Concurrency per key: decrement counter, wake workers
local concKey = redis.call('HGET', jobKey, 'concurrencyKey')
if concKey and concKey ~= '' then
  local counterKey = prefix .. 'conc:' .. concKey
  local val = redis.call('DECR', counterKey)
  if val <= 0 then
    redis.call('DEL', counterKey)
  end
  redis.call('ZADD', KEYS[4], 0, '0')
end

redis.call('XADD', KEYS[3], 'MAXLEN', '~', 10000, '*',
  'event', 'cancelled', 'jobId', jobId, 'reason', reason)

return 1
`;

// ── cleanJobs ──────────────────────────────────────────────────────
// KEYS[1] = sorted set for the state (completed/failed/expired/cancelled)
// ARGV[1] = jobPrefix
// ARGV[2] = cutoff timestamp
// ARGV[3] = max items to clean
// Returns: number of cleaned jobs
export const CLEAN_JOBS = `
local prefix = ARGV[1]
local cutoff = tonumber(ARGV[2])
local maxClean = tonumber(ARGV[3])
local cleaned = 0

local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', tostring(cutoff), 'LIMIT', 0, maxClean)
for _, jobId in ipairs(ids) do
  redis.call('ZREM', KEYS[1], jobId)
  local jobKey = prefix .. jobId
  redis.call('DEL', jobKey,
    jobKey .. ':data',
    jobKey .. ':result',
    jobKey .. ':lock',
    jobKey .. ':logs')
  cleaned = cleaned + 1
end

return cleaned
`;

// ── migrateWaitV1ToV2 ───────────────────────────────────────────────
// Per-key atomic migration of one `:wait` LIST to a ZSET, for the
// wireVersion 1 → 2 upgrade.
//
// Runs as a single Lua script so no concurrent writer can interleave
// between the LRANGE/HMGET phase and the DEL+ZADD swap — in particular,
// a stale wireVersion=1 worker doing `LPUSH wait id` cannot lose its
// write partway through. The write either lands in the LIST before the
// script grabs it (migrates cleanly) or hits `WRONGTYPE` after the
// script converts the key (which crashes the stale worker — acceptable,
// it should have been stopped before the upgrade anyway, and this is
// how we fail loud rather than silently drop jobs).
//
// The script is O(N) in the number of waiting job IDs for that single
// task: LRANGE of N, one HMGET per id (pipelined inside Lua, not a
// round-trip per id), one big ZADD with N score/member pairs. A task
// with ~10k waiting jobs spends ~10ms inside this script; ~100k spends
// ~100ms. Redis is blocked for exactly that window — one task at a
// time — so the TS-side caller SCANs the keyspace, never batches two
// tasks into one script, and loops until done.
//
// If the TS caller retries after a partial failure (Redis disconnect,
// timeout, etc.) the script is idempotent per-key: when `:wait` is
// already a ZSET there's nothing to migrate and we return 0.
//
// KEYS[1] = wait key (`taskora:{<task>}:wait`)
// ARGV[1] = jobPrefix (`taskora:{<task>}:`)
// Returns: number of jobs migrated (0 if already a ZSET or missing)
export const MIGRATE_WAIT_V1_TO_V2 = `
local waitKey = KEYS[1]
local prefix = ARGV[1]

-- Idempotent: if the key is already a ZSET, nothing to do. If it
-- doesn't exist at all, also nothing to do. Anything else (string,
-- hash, set, stream) is corrupt or not ours — bail with error.
local keyType = redis.call('TYPE', waitKey)
if type(keyType) == 'table' then keyType = keyType.ok end
if keyType == 'zset' or keyType == 'none' then
  return 0
end
if keyType ~= 'list' then
  return redis.error_reply('MIGRATE_WAIT: unexpected type ' .. keyType .. ' at ' .. waitKey)
end

local ids = redis.call('LRANGE', waitKey, 0, -1)
if #ids == 0 then
  redis.call('DEL', waitKey)
  return 0
end

-- Build the ZADD argument list: interleaved score, member pairs.
-- Scores are the same composite used by every enqueue path:
-- -priority * 1e13 + ts, read from each job's hash.
local zaddArgs = {}
for _, id in ipairs(ids) do
  local meta = redis.call('HMGET', prefix .. id, 'priority', 'ts')
  local prio = tonumber(meta[1]) or 0
  local ts = tonumber(meta[2]) or 0
  local score = -prio * 1e13 + ts
  zaddArgs[#zaddArgs + 1] = score
  zaddArgs[#zaddArgs + 1] = id
end

-- Atomic swap: delete the old LIST and create the new ZSET under
-- the same key in one script. A concurrent LPUSH from a stale v1
-- worker cannot interleave here — Lua scripts are serialized by
-- Redis. Either the LPUSH ran BEFORE this script (its id is in
-- the LRANGE we just took, so it migrates) or AFTER (it hits
-- WRONGTYPE against the new ZSET and the stale worker crashes).
redis.call('DEL', waitKey)
redis.call('ZADD', waitKey, unpack(zaddArgs))
return #ids
`;

// ── handshake ────────────────────────────────────────────────────────
// Atomically read-or-initialize the wire-format meta hash.
//
// KEYS[1] = meta key                 (e.g. "taskora:meta" or "taskora:<prefix>:meta")
// ARGV[1] = ours wireVersion
// ARGV[2] = ours minCompat
// ARGV[3] = ours writtenBy
// ARGV[4] = now (ms)
// Returns: flat array [wireVersion, minCompat, writtenBy, writtenAt]
//
// The meta key is created (with ours values) only if it does not already
// exist. If it does exist, the stored values are returned unchanged — core
// then runs the compat check and decides whether to proceed or throw.
// Core intentionally never triggers an in-place upgrade from here: bumping
// stored meta forward is a privileged operation we will add (behind a
// pre-1.0 feature flag) only once we need real rolling upgrades.
export const HANDSHAKE = `
local metaKey = KEYS[1]
local ourWire = tonumber(ARGV[1])
local ourMinCompat = tonumber(ARGV[2])
local ourWrittenBy = ARGV[3]
local now = ARGV[4]

if redis.call('EXISTS', metaKey) == 0 then
  redis.call('HSET', metaKey,
    'wireVersion', tostring(ourWire),
    'minCompat', tostring(ourMinCompat),
    'writtenBy', ourWrittenBy,
    'writtenAt', now)
  return {tostring(ourWire), tostring(ourMinCompat), ourWrittenBy, now}
end

local raw = redis.call('HMGET', metaKey, 'wireVersion', 'minCompat', 'writtenBy', 'writtenAt')
return {raw[1] or '', raw[2] or '', raw[3] or '', raw[4] or '0'}
`;

// ── enqueueBulk ─────────────────────────────────────────────────────
// Atomic bulk enqueue: loops over N jobs in a single Lua invocation.
// Handles both immediate and delayed jobs; emits one marker ZADD at the
// end instead of N.
//
// KEYS[1] = <task>:wait
// KEYS[2] = <task>:delayed
// KEYS[3] = <task>:events
// KEYS[4] = <task>:marker
// ARGV[1] = jobPrefix
// ARGV[2] = jobCount
// ARGV[3..] = per-job args, fixed stride of 12:
//   [0] jobId
//   [1] data (serialized)
//   [2] ts (ms)
//   [3] _v
//   [4] priority
//   [5] maxAttempts
//   [6] expireAt (0 = no TTL)
//   [7] concurrencyKey ("" = none)
//   [8] concurrencyLimit ("0" = none)
//   [9] delay (ms, 0 = immediate)
//   [10] _wf ("" = none)
//   [11] _wfNode ("" = none)
// Returns: number of jobs enqueued
export const ENQUEUE_BULK = `
local prefix = ARGV[1]
local count = tonumber(ARGV[2])
local stride = 12
local base = 3
local hasImmediate = false
local minDelayScore = nil

for i = 0, count - 1 do
  local off = base + i * stride
  local jobId       = ARGV[off]
  local data        = ARGV[off + 1]
  local ts          = ARGV[off + 2]
  local version     = ARGV[off + 3]
  local priority    = ARGV[off + 4]
  local maxAttempts = ARGV[off + 5]
  local expireAt    = ARGV[off + 6]
  local concKey     = ARGV[off + 7]
  local concLimit   = ARGV[off + 8]
  local delay       = tonumber(ARGV[off + 9])
  local wf          = ARGV[off + 10]
  local wfNode      = ARGV[off + 11]

  local jobKey  = prefix .. jobId
  local dataKey = jobKey .. ':data'

  if delay > 0 then
    local score = tonumber(ts) + delay
    if minDelayScore == nil or score < minDelayScore then
      minDelayScore = score
    end

    redis.call('HSET', jobKey,
      'ts', ts, 'delay', ARGV[off + 9], '_v', version,
      'attempt', 1, 'maxAttempts', maxAttempts,
      'state', 'delayed', 'priority', priority)
    if tonumber(expireAt) > 0 then
      redis.call('HSET', jobKey, 'expireAt', expireAt)
    end
    if concKey ~= '' then
      redis.call('HSET', jobKey, 'concurrencyKey', concKey,
                                  'concurrencyLimit', concLimit)
    end
    redis.call('SET', dataKey, data)
    redis.call('ZADD', KEYS[2], score, jobId)
    redis.call('XADD', KEYS[3], 'MAXLEN', '~', 10000, '*',
      'event', 'delayed', 'jobId', jobId)
  else
    hasImmediate = true
    redis.call('HSET', jobKey,
      'ts', ts, '_v', version,
      'attempt', 1, 'maxAttempts', maxAttempts,
      'state', 'waiting', 'priority', priority)
    if tonumber(expireAt) > 0 then
      redis.call('HSET', jobKey, 'expireAt', expireAt)
    end
    if concKey ~= '' then
      redis.call('HSET', jobKey, 'concurrencyKey', concKey,
                                  'concurrencyLimit', concLimit)
    end
    if wf ~= '' then
      redis.call('HSET', jobKey, '_wf', wf, '_wfNode', wfNode)
    end
    redis.call('SET', dataKey, data)
    local waitScore = -(tonumber(priority) or 0) * 1e13
                      + (tonumber(ts) or 0)
    redis.call('ZADD', KEYS[1], waitScore, jobId)
    redis.call('XADD', KEYS[3], 'MAXLEN', '~', 10000, '*',
      'event', 'waiting', 'jobId', jobId)
  end
end

-- Single marker wake instead of per-job
if hasImmediate then
  redis.call('ZADD', KEYS[4], 0, '0')
elseif minDelayScore then
  redis.call('ZADD', KEYS[4], 'LT', minDelayScore, '0')
end

return count
`;
