import { apiErrorShape } from '@repo/contracts';
import { ERROR_CODE, type ErrorCode } from '@repo/kernel';

/**
 * The ONE client-side error shape (ADR-0008). Every failed call this app makes surfaces as an
 * `ApiError`, whatever actually went wrong: a typed backend failure, a network drop, an HTML error
 * page from a misconfigured proxy. Features branch on `code` — a closed vocabulary owned by
 * `@repo/kernel` — and never on messages, status numbers or transport details (detect by type,
 * never by string).
 */
export class ApiError extends Error {
  /** The kernel wire vocabulary (`@repo/kernel`'s `ERROR_CODE`) — a types-only edge to the
   * backend, which is the entire allowed coupling. */
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    httpStatus: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.httpStatus = httpStatus;
    // `exactOptionalPropertyTypes`: assign the property only when there is something to assign
    // (the conditional-spread idiom, in its class-field form).
    if (details !== undefined) {
      this.details = details;
    }
  }
}

/** The generic message a non-conforming failure carries. Never the underlying error's own text:
 * a network stack trace or an HTML page fragment rendered into the UI is both useless to the user
 * and a small information leak. */
const GENERIC_MESSAGE = 'Something went wrong. Please try again.';

/**
 * What oRPC's client throws for a non-2xx response: an `ORPCError` whose `data.body` is the raw
 * response body — i.e. THIS api's uniform `{ code, message, details? }` wire shape
 * (`@repo/contracts`' `apiErrorShape`). Structurally typed rather than `instanceof ORPCError`
 * because that class travels through the link's own module instance, and a duplicated copy of
 * `@orpc/client` in the graph would silently break an `instanceof` check.
 */
interface OrpcErrorLike {
  readonly status?: unknown;
  readonly data?: { readonly body?: unknown };
}

/**
 * Normalizes anything thrown by a call into an {@link ApiError}.
 *
 * The backend's own wire shape wins when it is present and valid — parsed, not trusted
 * (ADR-0008: parse at the boundary), because `code` selects UI behaviour and a server that
 * returned something unexpected must not be able to steer it. Everything else — a network error,
 * an HTML error page, a thrown string — becomes `INTERNAL` with a generic message. oRPC's own
 * status-derived code is deliberately NOT used as the primary source: it maps HTTP statuses back
 * to *oRPC's* vocabulary, which coincides with the kernel's for the common codes and does not for
 * this product's own (`MAGIC_LINK_SEND_FAILED`).
 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }

  const candidate = error as OrpcErrorLike | null;
  const httpStatus = typeof candidate?.status === 'number' ? candidate.status : 500;
  const parsed = apiErrorShape.safeParse(candidate?.data?.body);
  if (parsed.success) {
    return new ApiError(parsed.data.code, parsed.data.message, httpStatus, parsed.data.details);
  }

  return new ApiError(ERROR_CODE.Internal, GENERIC_MESSAGE, httpStatus);
}

/**
 * better-auth's client does not THROW on a failed call — it resolves `{ data, error }`, where
 * `error` is the parsed response body flattened together with `status`/`statusText`. So the auth
 * flows need their own door into {@link ApiError}; routing them through {@link toApiError} would
 * find no `data.body` and flatten every auth failure to `INTERNAL`.
 *
 * The body's own `code` wins when it is one this product owns: `packages/auth` deliberately
 * surfaces `RATE_LIMITED` (the per-address magic-link bucket) and `MAGIC_LINK_SEND_FAILED` (a mail
 * outage) through better-auth's `APIError`, and those two are exactly the failures a user needs
 * different copy for. better-auth's OWN codes (`INVALID_ORIGIN`, …) are not kernel codes and fall
 * through to the status map below, which is the honest answer: they are misconfiguration, not
 * something the user can act on.
 */
export function toApiErrorFromAuthResponse(error: unknown): ApiError {
  const parsed = apiErrorShape.safeParse(error);
  const status =
    typeof (error as { readonly status?: unknown } | null)?.status === 'number'
      ? (error as { readonly status: number }).status
      : 500;
  if (parsed.success) {
    return new ApiError(parsed.data.code, parsed.data.message, status);
  }
  return new ApiError(errorCodeForStatus(status), GENERIC_MESSAGE, status);
}

/** The narrow status -> kernel-code map the auth flows need. Deliberately not a general-purpose
 * HTTP table: every other call in this app carries a typed `code` on the wire already, so this
 * exists solely for a library that does not. */
function errorCodeForStatus(status: number): ErrorCode {
  if (status === 400 || status === 422) {
    return ERROR_CODE.Validation;
  }
  if (status === 401) {
    return ERROR_CODE.Unauthorized;
  }
  if (status === 403) {
    return ERROR_CODE.Forbidden;
  }
  if (status === 429) {
    return ERROR_CODE.RateLimited;
  }
  return ERROR_CODE.Internal;
}
