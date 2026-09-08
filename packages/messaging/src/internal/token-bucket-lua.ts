/**
 * The token-bucket Lua script (frozen semantics): one `EVAL` per `tryAcquire` — atomic,
 * no EVALSHA cache dance at this scale. State is one Redis hash per bucket key (`tokens`,
 * `updated_at_ms`); time comes from `redis.call('TIME')` (server clock, immune to client skew).
 * A fresh/expired bucket starts FULL (capacity) — burst-friendly, token-bucket convention. Self-
 * cleans via `PEXPIRE` to twice the full-refill time so an idle bucket costs nothing forever.
 *
 * KEYS[1] = bucket key
 * ARGV[1] = capacity (integer > 0)
 * ARGV[2] = refillPerSecond (> 0, fractional allowed)
 * ARGV[3] = cost
 *
 * Returns [allowed (0|1), remainingTokens (string, preserves fractional precision), retryAfterMs].
 */
export const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerSecond = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])

local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

local data = redis.call('HMGET', key, 'tokens', 'updated_at_ms')
local tokens
local updatedAtMs
if data[1] == false then
  tokens = capacity
  updatedAtMs = nowMs
else
  tokens = tonumber(data[1])
  updatedAtMs = tonumber(data[2])
end

local elapsedMs = nowMs - updatedAtMs
if elapsedMs < 0 then
  elapsedMs = 0
end
local refilled = tokens + (elapsedMs * refillPerSecond / 1000)
if refilled > capacity then
  refilled = capacity
end

local allowed = 0
local retryAfterMs = 0
if refilled >= cost then
  allowed = 1
  refilled = refilled - cost
else
  retryAfterMs = math.ceil((cost - refilled) / refillPerSecond * 1000)
end

redis.call('HSET', key, 'tokens', tostring(refilled), 'updated_at_ms', tostring(nowMs))
local ttlMs = math.ceil((capacity / refillPerSecond) * 1000) * 2
redis.call('PEXPIRE', key, ttlMs)

return {allowed, tostring(refilled), retryAfterMs}
`;
