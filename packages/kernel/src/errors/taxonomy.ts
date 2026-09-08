import { AppError, type AppErrorOptions } from './app-error.js';
import { ERROR_CODE, type ErrorCode } from './error-code.js';

// Each subclass fixes its `code` from the ERROR_CODE const value set (ADR-0002) — no scattered
// string literals; the taxonomy and the wire shape both derive from that one source.

/** 400 — input failed validation. Never retryable: the caller must change the input first. */
export class ValidationError extends AppError {
  readonly code = ERROR_CODE.Validation;
  readonly httpStatus = 400 as const;
  readonly retryable = false as const;
}

/** 401 — missing/invalid credentials. Never retryable without re-authenticating. */
export class UnauthorizedError extends AppError {
  readonly code = ERROR_CODE.Unauthorized;
  readonly httpStatus = 401 as const;
  readonly retryable = false as const;
}

/** 403 — authenticated but not permitted. Never retryable. */
export class ForbiddenError extends AppError {
  readonly code = ERROR_CODE.Forbidden;
  readonly httpStatus = 403 as const;
  readonly retryable = false as const;
}

/** 404 — the referenced resource does not exist. Never retryable. */
export class NotFoundError extends AppError {
  readonly code = ERROR_CODE.NotFound;
  readonly httpStatus = 404 as const;
  readonly retryable = false as const;
}

/** 409 — the request conflicts with current state. Never retryable as-is. */
export class ConflictError extends AppError {
  readonly code = ERROR_CODE.Conflict;
  readonly httpStatus = 409 as const;
  readonly retryable = false as const;
}

/** 429 — caller exceeded a rate limit. Always retryable (after backoff). */
export class RateLimitedError extends AppError {
  readonly code = ERROR_CODE.RateLimited;
  readonly httpStatus = 429 as const;
  readonly retryable = true as const;
}

/**
 * Options for {@link ProviderError} and {@link InternalError}: retryability is set at the throw
 * site (ADR-0004) — e.g. a provider 503 may be constructed retryable, a provider 402 must not be.
 * Defaults to `false` (terminal) when omitted.
 */
export interface RetryableErrorOptions extends AppErrorOptions {
  readonly retryable?: boolean;
}

/** 502 — an upstream/external provider failed. Terminal (non-retryable) by default. */
export class ProviderError extends AppError {
  // Typed `ErrorCode`, not `'PROVIDER' as const`, for the same reason `httpStatus` is typed wide
  // below: a capability module MAY subclass a provider error with a funnel-distinguishing wire
  // code (e.g. the auth module's `MagicLinkSendFailedError` -> `MAGIC_LINK_SEND_FAILED`), and TS
  // rejects an override to a sibling literal unless the base admits it. The VALUE is unchanged
  // (`ERROR_CODE.Provider`); only the annotation widens.
  readonly code: ErrorCode = ERROR_CODE.Provider;
  // Typed `number`, not `502 as const`: `ProviderUnavailableError` (below) overrides this field
  // with a different literal (503) and TS rejects narrowing a subclass's literal-typed override
  // to an incompatible sibling literal (TS2416) — the base type must be wide enough to admit it.
  readonly httpStatus: number = 502;
  readonly retryable: boolean;

  constructor(message: string, options?: RetryableErrorOptions) {
    super(message, options);
    this.retryable = options?.retryable ?? false;
  }
}

/** 500 — unclassified failure inside our own code. Non-retryable by default. */
export class InternalError extends AppError {
  readonly code = ERROR_CODE.Internal;
  readonly httpStatus = 500 as const;
  readonly retryable: boolean;

  constructor(message: string, options?: RetryableErrorOptions) {
    super(message, options);
    this.retryable = options?.retryable ?? false;
  }
}

/**
 * 503 — the provider is temporarily unreachable/overloaded. Always retryable: this subtype
 * EXISTS to mark the transient case at the throw site (ADR-0003), where plain {@link ProviderError}
 * defaults terminal. `code` stays `ERROR_CODE.Provider` (the wire vocabulary does not grow,
 * ADR-0004): a 5xx consumer cares that the provider failed, not which transiency subclass.
 * `retryable` is fixed `true` — the constructor accepts no override (a caller who wants a
 * terminal provider failure throws {@link ProviderError} instead). The subclass set is closed at
 * nine; a new subtype requires re-opening ADR-0004.
 */
export class ProviderUnavailableError extends ProviderError {
  override readonly httpStatus: number = 503;

  constructor(message: string, options?: AppErrorOptions) {
    super(message, { ...options, retryable: true });
  }
}
