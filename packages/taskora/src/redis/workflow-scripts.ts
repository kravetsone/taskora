/**
 * Lua scripts for atomic workflow state transitions.
 *
 * All scripts operate on a single workflow hash key:
 *   taskora:wf:{workflowId} — Hash
 *
 * Fields:
 *   graph       — JSON serialized WorkflowGraph
 *   state       — "running" | "completed" | "failed" | "cancelled"
 *   createdAt   — timestamp
 *   result      — serialized final result
 *   error       — error message
 *   n:<i>:state — "pending" | "active" | "completed" | "failed" | "cancelled"
 *   n:<i>:result — serialized result (when completed)
 *   n:<i>:error  — error message (when failed)
 */

// ── createWorkflow ──────────────────────────────────────────────────
// KEYS[1] = workflow hash key
// ARGV[1] = graph JSON
// ARGV[2] = createdAt timestamp
// ARGV[3] = nodeCount
// Returns: 1
export const CREATE_WORKFLOW = `
local key = KEYS[1]
local graph = ARGV[1]
local createdAt = ARGV[2]
local nodeCount = tonumber(ARGV[3])

redis.call('HSET', key, 'graph', graph, 'state', 'running', 'createdAt', createdAt)

for i = 0, nodeCount - 1 do
  redis.call('HSET', key, 'n:' .. i .. ':state', 'pending')
end

return 1
`;

// ── advanceWorkflow ─────────────────────────────────────────────────
// KEYS[1] = workflow hash key
// ARGV[1] = nodeIndex (completed node)
// ARGV[2] = result (serialized)
// Returns: JSON array:
//   { "toDispatch": [...], "completed": bool, "result": "..." }
export const ADVANCE_WORKFLOW = `
local key = KEYS[1]
local nodeIndex = tonumber(ARGV[1])
local result = ARGV[2]

-- Check workflow is running
local state = redis.call('HGET', key, 'state')
if state ~= 'running' then
  return cjson.encode({ toDispatch = {}, completed = false })
end

-- Mark node completed
redis.call('HSET', key, 'n:' .. nodeIndex .. ':state', 'completed')
redis.call('HSET', key, 'n:' .. nodeIndex .. ':result', result)

-- Parse graph
local graph = cjson.decode(redis.call('HGET', key, 'graph'))
local nodes = graph.nodes
local toDispatch = {}

-- Find nodes whose deps are now all satisfied
for i = 1, #nodes do
  local idx = i - 1
  local nodeState = redis.call('HGET', key, 'n:' .. idx .. ':state')
  if nodeState == 'pending' then
    local node = nodes[i]
    local deps = node.deps

    -- Check if this node depends on the completed node
    local dependsOnCompleted = false
    for _, d in ipairs(deps) do
      if d == nodeIndex then
        dependsOnCompleted = true
        break
      end
    end

    if dependsOnCompleted then
      -- Check if ALL deps are completed
      local allDone = true
      for _, d in ipairs(deps) do
        local ds = redis.call('HGET', key, 'n:' .. d .. ':state')
        if ds ~= 'completed' then
          allDone = false
          break
        end
      end

      if allDone then
        -- Compute input data
        local inputData
        if node.data ~= nil and node.data ~= cjson.null then
          inputData = node.data
        elseif #deps == 1 then
          inputData = redis.call('HGET', key, 'n:' .. deps[1] .. ':result')
        else
          -- Multiple deps: build JSON array of results
          local parts = {}
          for _, d in ipairs(deps) do
            parts[#parts + 1] = redis.call('HGET', key, 'n:' .. d .. ':result')
          end
          inputData = '[' .. table.concat(parts, ',') .. ']'
        end

        redis.call('HSET', key, 'n:' .. idx .. ':state', 'active')

        toDispatch[#toDispatch + 1] = {
          nodeIndex = idx,
          taskName = node.taskName,
          data = inputData,
          jobId = node.jobId,
          _v = node._v,
        }
      end
    end
  end
end

-- Check if workflow is completed (all terminals done)
local terminals = graph.terminal
local allTerminalDone = true
for _, ti in ipairs(terminals) do
  local ts = redis.call('HGET', key, 'n:' .. ti .. ':state')
  if ts ~= 'completed' then
    allTerminalDone = false
    break
  end
end

if allTerminalDone then
  -- Build final result
  local finalResult
  if #terminals == 1 then
    finalResult = redis.call('HGET', key, 'n:' .. terminals[1] .. ':result')
  else
    local parts = {}
    for _, ti in ipairs(terminals) do
      parts[#parts + 1] = redis.call('HGET', key, 'n:' .. ti .. ':result')
    end
    finalResult = '[' .. table.concat(parts, ',') .. ']'
  end

  redis.call('HSET', key, 'state', 'completed')
  if finalResult then
    redis.call('HSET', key, 'result', finalResult)
  end

  return cjson.encode({ toDispatch = toDispatch, completed = true, result = finalResult })
end

return cjson.encode({ toDispatch = toDispatch, completed = false })
`;

// ── failWorkflow ────────────────────────────────────────────────────
// KEYS[1] = workflow hash key
// ARGV[1] = nodeIndex (failed node)
// ARGV[2] = error message
// Returns: JSON array of { task, jobId } for active jobs to cancel
export const FAIL_WORKFLOW = `
local key = KEYS[1]
local nodeIndex = tonumber(ARGV[1])
local error = ARGV[2]

local state = redis.call('HGET', key, 'state')
if state ~= 'running' then
  return cjson.encode({ activeJobIds = {} })
end

-- Mark node and workflow as failed
redis.call('HSET', key,
  'n:' .. nodeIndex .. ':state', 'failed',
  'n:' .. nodeIndex .. ':error', error,
  'state', 'failed',
  'error', error)

-- Parse graph, collect active job IDs, mark pending/active as failed
local graph = cjson.decode(redis.call('HGET', key, 'graph'))
local activeJobIds = {}

for i = 1, #graph.nodes do
  local idx = i - 1
  if idx ~= nodeIndex then
    local ns = redis.call('HGET', key, 'n:' .. idx .. ':state')
    if ns == 'active' then
      activeJobIds[#activeJobIds + 1] = {
        task = graph.nodes[i].taskName,
        jobId = graph.nodes[i].jobId,
      }
      redis.call('HSET', key, 'n:' .. idx .. ':state', 'failed')
    elseif ns == 'pending' then
      redis.call('HSET', key, 'n:' .. idx .. ':state', 'failed')
    end
  end
end

return cjson.encode({ activeJobIds = activeJobIds })
`;

// ── cancelWorkflow ──────────────────────────────────────────────────
// KEYS[1] = workflow hash key
// ARGV[1] = reason ("" = none)
// Returns: JSON array of { task, jobId } for active jobs to cancel
export const CANCEL_WORKFLOW = `
local key = KEYS[1]
local reason = ARGV[1]

local state = redis.call('HGET', key, 'state')
if state ~= 'running' then
  return cjson.encode({ activeJobIds = {} })
end

redis.call('HSET', key, 'state', 'cancelled')
if reason ~= '' then
  redis.call('HSET', key, 'error', reason)
end

local graph = cjson.decode(redis.call('HGET', key, 'graph'))
local activeJobIds = {}

for i = 1, #graph.nodes do
  local idx = i - 1
  local ns = redis.call('HGET', key, 'n:' .. idx .. ':state')
  if ns == 'active' then
    activeJobIds[#activeJobIds + 1] = {
      task = graph.nodes[i].taskName,
      jobId = graph.nodes[i].jobId,
    }
    redis.call('HSET', key, 'n:' .. idx .. ':state', 'cancelled')
  elseif ns == 'pending' then
    redis.call('HSET', key, 'n:' .. idx .. ':state', 'cancelled')
  end
end

return cjson.encode({ activeJobIds = activeJobIds })
`;
