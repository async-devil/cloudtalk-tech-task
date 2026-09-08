import { jobIdFor } from '../job-id.js';

/**
 * BullMQ's own API literal (not a value invented here): setting `backoff.type` to `'custom'`
 * directs BullMQ to call the worker's registered `settings.backoffStrategy` function instead of a
 * built-in (`fixed`/`exponential`) curve. The string is imposed by the pinned `bullmq` dependency
 * (registry table); see BullMQ's `BackoffOptions` typing. Named per ADR-0003 §4 — no magic string.
 */
export const BACKOFF_TYPE_CUSTOM = 'custom';

/**
 * How many completed jobs BullMQ retains per queue (`removeOnComplete.count`). Sized for a
 * post-mortem debugging window without letting completed-job hashes grow unbounded in Redis
 * memory. Named per ADR-0003 §4; if a future WI needs it tunable it becomes a messaging
 * config-slice key — until then a named constant with its rationale suffices.
 */
export const COMPLETED_JOBS_RETAINED = 1000;

/** The frozen producer job-options shape (named invariant), factored out as a pure
 * function so its shape is unit-testable without a live Redis connection. */
export interface ProducerJobOptions {
  readonly jobId: string;
  readonly attempts: number;
  readonly backoff: { readonly type: typeof BACKOFF_TYPE_CUSTOM };
  readonly removeOnComplete: { readonly count: number };
  readonly removeOnFail: false;
}

export function producerJobOptions(
  stage: string,
  entityId: string,
  attempts: number,
): ProducerJobOptions {
  return {
    jobId: jobIdFor(stage, entityId),
    attempts,
    backoff: { type: BACKOFF_TYPE_CUSTOM },
    removeOnComplete: { count: COMPLETED_JOBS_RETAINED },
    removeOnFail: false,
  };
}
