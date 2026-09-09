import { APP_ERROR_BRAND } from '../internal/app-error-shape.js';
import type { JsonObject } from '../types/json.js';
import type { ErrorCode } from './error-code.js';

/** Options accepted by every {@link AppError} constructor. */
export interface AppErrorOptions {
  /** Safe-for-wire structured context; never internals (ADR-0008). */
  readonly details?: JsonObject;
  /** ES2022 cause chaining. */
  readonly cause?: unknown;
}

/**
 * Base of the kernel error taxonomy (ADR-0008). Every subclass fixes its own `code`,
 * `httpStatus`, and `retryable` at the definition site — retryability is a property of the
 * type, never inferred by matching on `name`/`message`. Errors crossing a port are part of that
 * port's contract (declared in TSDoc) and are detected via {@link isAppError} (instanceof, with a
 * brand+shape fallback).
 */
export abstract class AppError extends Error {
  /** Cross-realm/extraction-safe detection tag; always the literal `'AppError'`. */
  readonly brand: 'AppError' = APP_ERROR_BRAND;
  abstract readonly code: ErrorCode;
  abstract readonly httpStatus: number;
  abstract readonly retryable: boolean;
  // `declare` suppresses TS's default class-field initializer (target ES2022 defines fields via
  // `Object.defineProperty`, which would otherwise set `details` to `undefined` as an own
  // property on every instance) — this field is only ever assigned when a caller actually
  // supplies `details`, so `'details' in err` is false otherwise (exactOptionalPropertyTypes).
  declare readonly details?: JsonObject;

  constructor(message: string, options?: AppErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    if (options?.details !== undefined) {
      this.details = options.details;
    }
  }
}
