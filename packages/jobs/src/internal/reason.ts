/**
 * ADR-0006 §4: `jobs.dead_letter.reason` and every `last_error` column the spine writes are
 * bounded, not content-free — callers reach for classifier output first
 * (`classifyRetry(error).reason` / `describeError(error)`), and this is the backstop that keeps
 * an accidentally-passed raw provider body from becoming an unbounded PII sink.
 */
export const REASON_MAX_LENGTH = 500;

/** Truncates `reason` to {@link REASON_MAX_LENGTH} characters. */
export function truncateReason(reason: string): string {
  return reason.length > REASON_MAX_LENGTH ? reason.slice(0, REASON_MAX_LENGTH) : reason;
}
