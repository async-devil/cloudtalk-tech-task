/**
 * Brand + shape-check helpers shared by `errors/app-error.ts` (which stamps the brand) and
 * `errors/is-app-error.ts` (which reads it) — one definition of "what an AppError looks like",
 * kept in `internal/` per the package template (never exported from the barrel).
 */
import type { ErrorCode } from '../errors/error-code.js';

/** The literal cross-realm/extraction-safe detection tag stamped on every `AppError`. */
export const APP_ERROR_BRAND = 'AppError';

/** The minimal duck-typed shape `isAppError` accepts when `instanceof AppError` cannot be used —
 * e.g. an instance built from a different copy of the `AppError` class (a duplicated
 * `@repo/kernel` in the dependency graph, or a hand-authored lookalike in a test). Checking
 * `brand` plus the fixed fields (never `name`/`message`) is what makes detection survive that
 * case, per ADR-0008's "detected by instanceof/brand — never by name/message matching". */
export function hasAppErrorShape(value: unknown): value is {
  readonly brand: 'AppError';
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
} {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    value instanceof Error &&
    candidate.brand === APP_ERROR_BRAND &&
    typeof candidate.code === 'string' &&
    typeof candidate.httpStatus === 'number' &&
    typeof candidate.retryable === 'boolean'
  );
}
