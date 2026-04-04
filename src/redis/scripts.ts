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
// ARGV[1] = jobPrefix        (e.g. "taskora:{send-email}:")
// ARGV[2] = jobId            (client-generated UUID)
// ARGV[3] = serialized data
// ARGV[4] = timestamp (ms)
// ARGV[5] = _v (version)
// ARGV[6] = priority
// Returns: 1
export const ENQUEUE = `
local jobKey = ARGV[1] .. ARGV[2]
local dataKey = jobKey .. ':data'

redis.call('HSET', jobKey,
  'ts', ARGV[4],
  '_v', ARGV[5],
  'attempt', 1,
  'state', 'waiting',
  'priority', ARGV[6])

redis.call('SET', dataKey, ARGV[3])
redis.call('LPUSH', KEYS[1], ARGV[2])

redis.call('XADD', KEYS[2], 'MAXLEN', '~', 10000, '*',
  'event', 'waiting', 'jobId', ARGV[2])

return 1
`;

// ── enqueueDelayed ───────────────────────────────────────────────────
// KEYS[1] = <task>:delayed   (delayed sorted set)
// KEYS[2] = <task>:events
// ARGV[1] = jobPrefix
// ARGV[2] = jobId            (client-generated UUID)
// ARGV[3] = serialized data
// ARGV[4] = timestamp (ms)
// ARGV[5] = _v
// ARGV[6] = delay (ms)
// ARGV[7] = priority
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
  'state', 'delayed',
  'priority', ARGV[7])

redis.call('SET', dataKey, ARGV[3])
redis.call('ZADD', KEYS[1], score, ARGV[2])

redis.call('XADD', KEYS[2], 'MAXLEN', '~', 10000, '*',
  'event', 'delayed', 'jobId', ARGV[2])

return 1
`;

// ── dequeue ──────────────────────────────────────────────────────────
// KEYS[1] = <task>:wait
// KEYS[2] = <task>:active
// KEYS[3] = <task>:delayed
// KEYS[4] = <task>:events
// ARGV[1] = jobPrefix
// ARGV[2] = lock TTL (ms)
// ARGV[3] = lock token (UUID)
// ARGV[4] = current timestamp (ms)
// Returns: {id, data, _v, attempt, ts} or nil
export const DEQUEUE = `
local prefix = ARGV[1]
local lockTtl = ARGV[2]
local token = ARGV[3]
local now = tonumber(ARGV[4])

-- Promote delayed jobs whose due time <= now (up to 100)
local maxScore = now
local delayed = redis.call('ZRANGEBYSCORE', KEYS[3], 0, maxScore, 'LIMIT', 0, 100)
if #delayed > 0 then
  redis.call('ZREM', KEYS[3], unpack(delayed))
  -- Reverse iteration preserves FIFO among promoted jobs
  for i = #delayed, 1, -1 do
    local jid = delayed[i]
    redis.call('RPUSH', KEYS[1], jid)
    redis.call('HSET', prefix .. jid, 'state', 'waiting')
    redis.call('XADD', KEYS[4], 'MAXLEN', '~', 10000, '*',
      'event', 'promoted', 'jobId', jid)
  end
end

-- Pop oldest from wait -> active (LMOVE RIGHT LEFT = RPOPLPUSH)
local id = redis.call('LMOVE', KEYS[1], KEYS[2], 'RIGHT', 'LEFT')
if not id then return nil end

local jobKey = prefix .. id
local lockKey = jobKey .. ':lock'
local dataKey = jobKey .. ':data'

-- Acquire lock
redis.call('SET', lockKey, token, 'PX', lockTtl)

-- Update state
redis.call('HSET', jobKey, 'state', 'active', 'processedOn', tostring(now))

-- Read job data + metadata
local data = redis.call('GET', dataKey)
local meta = redis.call('HMGET', jobKey, '_v', 'attempt', 'ts')

redis.call('XADD', KEYS[4], 'MAXLEN', '~', 10000, '*',
  'event', 'active', 'jobId', id)

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
// ARGV[1] = jobPrefix
// ARGV[2] = jobId
// ARGV[3] = lock token
// ARGV[4] = error message
// ARGV[5] = current timestamp
// Returns: 1 or error
export const FAIL = `
local prefix = ARGV[1]
local jobId = ARGV[2]
local token = ARGV[3]
local errMsg = ARGV[4]
local now = ARGV[5]

local jobKey = prefix .. jobId
local lockKey = jobKey .. ':lock'

local lockVal = redis.call('GET', lockKey)
if lockVal ~= token then
  return redis.error_reply('LOCK_MISMATCH')
end

redis.call('LREM', KEYS[1], 1, jobId)
redis.call('DEL', lockKey)
redis.call('HSET', jobKey, 'state', 'failed', 'finishedOn', now, 'error', errMsg)
redis.call('ZADD', KEYS[2], tonumber(now), jobId)

redis.call('XADD', KEYS[3], 'MAXLEN', '~', 10000, '*',
  'event', 'failed', 'jobId', jobId)

return 1
`;

// ── nack ─────────────────────────────────────────────────────────────
// KEYS[1] = <task>:active
// KEYS[2] = <task>:wait
// KEYS[3] = <task>:events
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

redis.call('XADD', KEYS[3], 'MAXLEN', '~', 10000, '*',
  'event', 'waiting', 'jobId', jobId)

return 1
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
