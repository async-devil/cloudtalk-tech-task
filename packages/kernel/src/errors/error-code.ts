/**
 * The closed set of kernel error codes (ADR-0008), as a const-object value set (ADR-0003): one
 * source of truth; the `ErrorCode` union and the `ERROR_CODES` list are both derived, and the wire
 * shape (`apiErrorShape.code`, `@repo/contracts`) reuses `ERROR_CODES` for its `z.enum` so it can
 * no longer drift from this taxonomy.
 */
export const ERROR_CODE = {
  Validation: 'VALIDATION',
  Unauthorized: 'UNAUTHORIZED',
  Forbidden: 'FORBIDDEN',
  NotFound: 'NOT_FOUND',
  Conflict: 'CONFLICT',
  RateLimited: 'RATE_LIMITED',
  Provider: 'PROVIDER',
  Internal: 'INTERNAL',
  /**
   * The magic-link sign-in funnel's typed send failure (ADR-0006: "typed, never a bare 500 on the
   * sign-in funnel"). The kernel stays the single home of the wire vocabulary: the class that
   * carries it — `MagicLinkSendFailedError` (a `ProviderUnavailableError` subclass) — lives in
   * `@repo/auth`, the module that throws it. The sign-in UI keys directly on this code.
   */
  MagicLinkSendFailed: 'MAGIC_LINK_SEND_FAILED',
} as const;
export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];
export const ERROR_CODES = Object.values(ERROR_CODE) as readonly ErrorCode[];
