import { ERROR_CODE, type ErrorCode } from '@repo/kernel';

/**
 * `ApiError.code` -> the copy this app shows for it.
 *
 * IN `shared/`, NOT IN A FEATURE. The mapping is not any one feature's opinion — it began as a
 * candidate for living inside a feature slice, which would have made it unreachable from every
 * other slice: features may not import each other (the slice-isolation rule), so a second consumer
 * would have needed a duplicate table or a boundary violation. The mapping is the app's.
 *
 * TOTAL BY CONSTRUCTION. The `Record<ErrorCode, string>` annotation is the point: adding a code to
 * `@repo/kernel`'s `ERROR_CODE` without adding copy for it is a COMPILE error here, not a blank
 * error banner discovered in production.
 *
 * WHY NOT RENDER `ApiError.message`. It is written for an operator reading a log, and on a
 * non-conforming failure (a proxy's HTML error page, a network drop) it is not a sentence at all —
 * `shared/errors` deliberately replaces those with a generic string rather than leaking transport
 * detail into the UI.
 */
const MESSAGE_BY_ERROR_CODE: Readonly<Record<ErrorCode, string>> = {
  [ERROR_CODE.Validation]: 'Please check what you entered and try again.',
  [ERROR_CODE.Unauthorized]: 'Please sign in to continue.',
  [ERROR_CODE.Forbidden]: 'You do not have access to this.',
  [ERROR_CODE.NotFound]: 'We could not find that.',
  [ERROR_CODE.Conflict]: 'That has already changed. Reload and try again.',
  [ERROR_CODE.RateLimited]: 'Too many requests. Please wait a moment and try again.',
  [ERROR_CODE.Provider]: 'A service we depend on is unavailable. Please try again shortly.',
  [ERROR_CODE.Internal]: 'Something went wrong. Please try again.',
  [ERROR_CODE.MagicLinkSendFailed]: 'We could not send your sign-in link. Please try again.',
};

/** The display copy for a wire error code. */
export function errorMessageFor(code: ErrorCode): string {
  return MESSAGE_BY_ERROR_CODE[code];
}
