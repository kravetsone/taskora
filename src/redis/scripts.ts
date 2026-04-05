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

redis.call('SET', dataKey, ARGV[3])
redis.call('LPUSH', KEYS[1], ARGV[2])
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
// ARGV[1] = jobPrefix
// ARGV[2] = lock TTL (ms)
// ARGV[3] = lock token (UUID)
// ARGV[4] = current timestamp (ms)
// Returns: {id, data, _v, attempt, ts} or nil
export const MOVE_TO_ACTIVE = `
local prefix = ARGV[1]
local lockTtl = ARGV[2]
local token = ARGV[3]
local now = tonumber(ARGV[4])

-- Promote delayed jobs whose due time <= now (up to 100)
local delayed = redis.call('ZRANGEBYSCORE', KEYS[3], 0, now, 'LIMIT', 0, 100)
if #delayed > 0 then
  redis.call('ZREM', KEYS[3], unpack(delayed))
  for i = #delayed, 1, -1 do
    local jid = delayed[i]
    redis.call('RPUSH', KEYS[1], jid)
    redis.call('HSET', prefix .. jid, 'state', 'waiting')
    redis.call('XADD', KEYS[4], 'MAXLEN', '~', 10000, '*',
      'event', 'promoted', 'jobId', jid)
  end
end

-- Pop oldest from wait -> active
local id = redis.call('LMOVE', KEYS[1], KEYS[2], 'RIGHT', 'LEFT')
if not id then
  -- No immediate work. Set marker for next delayed if any.
  local next = redis.call('ZRANGEBYSCORE', KEYS[3], 0, '+inf', 'LIMIT', 0, 1, 'WITHSCORES')
  if #next > 0 then
    redis.call('ZADD', KEYS[5], next[2], '0')
  end
  return nil
end

local jobKey = prefix .. id
local lockKey = jobKey .. ':lock'
local dataKey = jobKey .. ':data'

redis.call('SET', lockKey, token, 'PX', lockTtl)
redis.call('HSET', jobKey, 'state', 'active', 'processedOn', tostring(now))

local data = redis.call('GET', dataKey)
local meta = redis.call('HMGET', jobKey, '_v', 'attempt', 'ts')

redis.call('XADD', KEYS[4], 'MAXLEN', '~', 10000, '*',
  'event', 'active', 'jobId', id)

-- Re-add marker if more work exists
local waitLen = redis.call('LLEN', KEYS[1])
if waitLen > 0 then
  redis.call('ZADD', KEYS[5], 0, '0')
else
  local next = redis.call('ZRANGEBYSCORE', KEYS[3], 0, '+inf', 'LIMIT', 0, 1, 'WITHSCORES')
  if #next > 0 then
    redis.call('ZADD', KEYS[5], next[2], '0')
  end
end

return {id, data, meta[1], meta[2], meta[3]}
`;

// ── ack ──────────────────────────────────────────────────────────────
// KEYS[1] = <task>:active
// KEYS[2] = <task>:completed  (sorted set, score = finishedOn)
// KEYS[3] = <task>:events
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
redis.call('HSET', jobKey, 'state', 'waiting')
redis.call('RPUSH', KEYS[2], jobId)
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
    local count = redis.call('HINCRBY', jobKey, 'stalledCount', 1)

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
      redis.call('RPUSH', KEYS[3], jobId)
      redis.call('ZADD', KEYS[6], 0, '0')

      redis.call('XADD', KEYS[5], 'MAXLEN', '~', 10000, '*',
        'event', 'stalled', 'jobId', jobId,
        'count', tostring(count), 'action', 'recovered')

      table.insert(recovered, jobId)
    end
  end

  redis.call('SREM', KEYS[1], jobId)
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
