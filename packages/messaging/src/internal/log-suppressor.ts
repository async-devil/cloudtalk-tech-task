import type { Logger } from '@repo/observability';

/** Default suppression window: "never fully silent" — at most one WARN per interval. */
export const DEFAULT_SUPPRESSION_INTERVAL_MS = 60_000;

/**
 * Log-once-per-interval (ADR-0007: "never fully silent"): the first call logs
 * immediately; further calls within `intervalMs` are counted but not logged; the next call once
 * the interval has elapsed logs again, carrying `suppressedCount` for the occurrences swallowed
 * in between. Each suppressor instance owns its own state — callers create one per logical
 * failure site (e.g. one per bus, not a global keyed map) so unrelated failures never share a
 * suppression window.
 */
export function createIntervalSuppressor(
  intervalMs: number = DEFAULT_SUPPRESSION_INTERVAL_MS,
): (logger: Logger, message: string, bindings?: Record<string, unknown>) => void {
  let lastLoggedAt: number | undefined;
  let suppressedCount = 0;

  return (logger: Logger, message: string, bindings?: Record<string, unknown>): void => {
    const now = Date.now();
    if (lastLoggedAt === undefined || now - lastLoggedAt >= intervalMs) {
      logger.warn({ ...bindings, suppressedCount }, message);
      lastLoggedAt = now;
      suppressedCount = 0;
      return;
    }
    suppressedCount += 1;
  };
}
