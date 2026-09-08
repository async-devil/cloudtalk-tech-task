/** Maps {@link WorkerOptions.limiter} to BullMQ's worker-level `limiter: { max, duration }`
 * option (-pinned invariant) — factored out as a pure function so the field-name
 * mapping is unit-testable without a live Redis connection. */
export interface WorkerLimiterOptions {
  readonly max: number;
  readonly duration: number;
}

export function workerLimiterOptions(limiter: {
  readonly max: number;
  readonly durationMs: number;
}): WorkerLimiterOptions {
  return { max: limiter.max, duration: limiter.durationMs };
}
