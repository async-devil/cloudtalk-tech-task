import { ERROR_CODE, ProviderUnavailableError } from '@repo/kernel';

/**
 * The magic-link sign-in funnel's typed send failure (ADR-0013: typed, never a bare 500 on the
 * sign-in funnel). It lives in the module that throws it, while its wire code
 * (`ERROR_CODE.MagicLinkSendFailed`) lives in `@repo/kernel`, the single home of the wire
 * vocabulary — a deliberate split, because the client switches on the code and only this module
 * knows when to raise it. It IS a `ProviderUnavailableError` (503, retryable) with a
 * funnel-distinguishing code, so `classifyRetry` routes it by `retryable` with no table edit and
 * the sign-in screen can key directly on the code.
 */
export class MagicLinkSendFailedError extends ProviderUnavailableError {
  override readonly code = ERROR_CODE.MagicLinkSendFailed;
}
