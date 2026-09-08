/** Backoff shape for producer/worker retry delays (frozen). */
export interface BackoffOptions {
  readonly baseMs: number;
  readonly capMs: number;
}

/** Default producer backoff: `{ baseMs: 1000, capMs: 60_000 }`. */
export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1000, capMs: 60_000 };

/** Default producer attempts. */
export const DEFAULT_ATTEMPTS = 5;

/**
 * Full jitter backoff (named invariant): `random(0, min(capMs, baseMs * 2**attempt))`.
 * `attempt` is the number of attempts already made (BullMQ's `attemptsMade`, 0-indexed on the
 * first retry) — deterministic bounds, non-deterministic point within them.
 */
export function fullJitterBackoff(attempt: number, options: BackoffOptions): number {
  const cap = Math.min(options.capMs, options.baseMs * 2 ** attempt);
  return Math.random() * cap;
}
