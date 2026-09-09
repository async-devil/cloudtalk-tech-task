import { hasAppErrorShape } from '../internal/app-error-shape.js';
import { AppError } from './app-error.js';

/**
 * Detects an {@link AppError} instance. Checks `instanceof` first (the common, same-realm,
 * same-copy case) and falls back to the brand+shape check so instances constructed from a
 * different copy of the `AppError` class (e.g. a duplicated `@repo/kernel` in the dependency
 * graph) are still recognized. Never matches by `name`/`message` (ADR-0008).
 */
export function isAppError(value: unknown): value is AppError {
  if (value instanceof AppError) {
    return true;
  }
  return hasAppErrorShape(value);
}
