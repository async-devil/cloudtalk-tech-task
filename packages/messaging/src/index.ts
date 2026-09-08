// Public barrel — the module's entire public contract (ADR-0003: one barrel, no nested barrels).
export { type BackoffOptions, fullJitterBackoff } from './backoff.js';
export {
  type BestEffortEventBus,
  BUS_CHANNEL,
  createBestEffortEventBus,
} from './bus.js';
export { configSlice, type MessagingSliceConfig } from './config-slice.js';
export type { MessagingConnection } from './connection.js';
export { jobIdFor } from './job-id.js';
export { createQueue, type Enqueuer, type QueueOptions } from './queue.js';
export {
  computeTokenBucketRefill,
  createRequestsPerMinuteRateLimiter,
  createTokenBucketRateLimiter,
  type RateLimiter,
  type TokenBucketDecision,
  type TokenBucketOptions,
} from './rate-limiter.js';
export {
  getRegisteredSchedulerIds,
  type RepeatableScheduleOptions,
  type RepeatableSchedulerLookupOptions,
  scheduleRepeatable,
} from './repeatable.js';
export {
  createSlidingWindowRateLimiter,
  type SlidingWindowDecision,
  type SlidingWindowOptions,
  type SlidingWindowRateLimiter,
} from './sliding-window-rate-limiter.js';
export {
  createWorker,
  JOB_OUTCOME,
  type JobOutcome,
  type WorkerHandle,
  type WorkerOptions,
} from './worker.js';
