/**
 * The sliding-window Lua script: one `EVAL`
 * per `tryAcquire` — atomic, the same token-bucket discipline (`token-bucket-lua.ts`).
 * State is one Redis ZSET per subject key, scored by `redis.call('TIME')`-derived milliseconds.
 * Per acquire: prune members scored older than `windowMs` (`ZREMRANGEBYSCORE`), count what
 * remains, and either add the event (allowed) or compute `retryAfterMs` from the oldest
 * surviving member's score (denied); `PEXPIRE windowMs` on every call — an idle subject's key
 * self-cleans and costs nothing.
 *
 * KEYS[1] = subject key (`${bucketKeyPrefix}:${subjectKey}`)
 * ARGV[1] = limit (integer > 0)
 * ARGV[2] = windowMs (integer > 0)
 *
 * Returns [allowed (0|1), remaining (integer, floor 0), retryAfterMs (0 when allowed)].
 *
 * Member uniqueness: a ZSET member must be unique, and `TIME`'s microsecond component alone is
 * not — two `EVAL`s issued back-to-back with no real network round-trip between them (this
 * repo's own concurrency proof, `test-integration/probes/sliding-window.probe.ts`) can land in
 * the SAME microsecond, and a collided `ZADD` overwrites rather than adds, silently undercounting
 * `ZCARD` and letting MORE than `limit` requests through (over-admission — verified empirically:
 * the first version of this script used `TIME`'s microseconds alone and failed the concurrency
 * proof at limit 10 / 30 concurrent calls). A companion `${key}:seq` counter key
 * (`INCR`, itself deterministic and script-legal) guarantees a genuinely distinct member per
 * admitted event regardless of timestamp collisions; it self-expires alongside the main key.
 */
export const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local seqKey = key .. ':seq'
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])

local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local windowStart = nowMs - windowMs

redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)
local count = redis.call('ZCARD', key)

local allowed = 0
local retryAfterMs = 0
local remaining = limit - count
if remaining < 0 then
  remaining = 0
end

if count < limit then
  allowed = 1
  local seq = redis.call('INCR', seqKey)
  local member = tostring(nowMs) .. '-' .. tostring(seq)
  redis.call('ZADD', key, nowMs, member)
  remaining = limit - count - 1
  if remaining < 0 then
    remaining = 0
  end
else
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  if oldest[2] ~= nil then
    retryAfterMs = tonumber(oldest[2]) + windowMs - nowMs
    if retryAfterMs < 0 then
      retryAfterMs = 0
    end
  end
end

redis.call('PEXPIRE', key, windowMs)
redis.call('PEXPIRE', seqKey, windowMs)

return {allowed, remaining, retryAfterMs}
`;
