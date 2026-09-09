import { isAppError } from './is-app-error.js';

/**
 * The retry decision (ADR-0008), as a const-object value set (ADR-0003): one source of truth; the
 * `RetryDecision` union is derived.
 */
export const RETRY_DECISION = {
  Retry: 'retry',
  Terminal: 'terminal',
} as const;
export type RetryDecision = (typeof RETRY_DECISION)[keyof typeof RETRY_DECISION];

export interface RetryClassification {
  readonly decision: RetryDecision;
  /** Non-empty machine-greppable reason, exactly as the frozen table below states it. Feeds
   * terminal logs now and DLQ rows. */
  readonly reason: string;
}

/**
 * The frozen retryable network-code set (rule 6 below). Exported so the table-driven suite and
 * future additions stay in lockstep with the classifier — extending it is a reviewed change to
 * this one list plus its test rows in the same PR.
 *
 * Deliberately EXCLUDED: `ENOTFOUND` (a wrong hostname is a config bug — retrying re-bills
 * nothing but heals nothing; it still reaches rule 7 and retries as *unknown*, but is not
 * endorsed as *known-transient*).
 */
export const RETRYABLE_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const MIN_HTTP_STATUS = 100;
const MAX_HTTP_STATUS = 599;
const CLIENT_ERROR_MIN = 400;
const CLIENT_ERROR_MAX = 499;
const SERVER_ERROR_MIN = 500;
const SERVER_ERROR_MAX = 599;
const RATE_LIMITED_STATUS = 429;

function isValidHttpStatus(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_HTTP_STATUS &&
    value <= MAX_HTTP_STATUS
  );
}

/**
 * Status extraction (frozen): the first of `error.status`, `error.statusCode`,
 * `error.response?.status` (fetch-/axios-style SDK shapes) that is an integer in `100–599`,
 * reading own enumerable properties only. Anything else — strings, floats, out-of-range numbers —
 * is "no status".
 */
function extractHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  if (isValidHttpStatus(record.status)) {
    return record.status;
  }
  if (isValidHttpStatus(record.statusCode)) {
    return record.statusCode;
  }
  const response = record.response;
  if (typeof response === 'object' && response !== null) {
    const nestedStatus = (response as Record<string, unknown>).status;
    if (isValidHttpStatus(nestedStatus)) {
      return nestedStatus;
    }
  }
  return undefined;
}

function extractNetworkCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const code = (error as Record<string, unknown>).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * `classifyRetry` (ADR-0003, ADR-0008). Type-first, structured-field fallback — no name/message
 * matching anywhere, including for foreign errors. Rules evaluate top-down; first match wins
 * (frozen table):
 *
 * 1. `isAppError(error)` and `error.retryable` -> Retry, `app-error-retryable:{code}`.
 * 2. `isAppError(error)` and not `error.retryable` -> Terminal, `app-error-terminal:{code}`.
 * 3. extracted HTTP status === 429 -> Retry, `http-status:429`.
 * 4. extracted HTTP status in 400–499 -> Terminal, `http-status:{status}`.
 * 5. extracted HTTP status in 500–599 -> Retry, `http-status:{status}`.
 * 6. own `code` is a string in {@link RETRYABLE_NETWORK_CODES} -> Retry, `network:{code}`.
 * 7. anything else (incl. non-`Error` throwables) -> Retry, `unknown-default-retry`.
 *
 * Rule 7 is ADR-0003's explicit default: unknown errors retry, bounded by the transport's
 * attempts ceiling — the classifier itself never loops.
 */
export function classifyRetry(error: unknown): RetryClassification {
  if (isAppError(error)) {
    return error.retryable
      ? { decision: RETRY_DECISION.Retry, reason: `app-error-retryable:${error.code}` }
      : { decision: RETRY_DECISION.Terminal, reason: `app-error-terminal:${error.code}` };
  }

  const status = extractHttpStatus(error);
  if (status !== undefined) {
    if (status === RATE_LIMITED_STATUS) {
      return { decision: RETRY_DECISION.Retry, reason: `http-status:${status}` };
    }
    if (status >= CLIENT_ERROR_MIN && status <= CLIENT_ERROR_MAX) {
      return { decision: RETRY_DECISION.Terminal, reason: `http-status:${status}` };
    }
    if (status >= SERVER_ERROR_MIN && status <= SERVER_ERROR_MAX) {
      return { decision: RETRY_DECISION.Retry, reason: `http-status:${status}` };
    }
  }

  const networkCode = extractNetworkCode(error);
  if (networkCode !== undefined && RETRYABLE_NETWORK_CODES.has(networkCode)) {
    return { decision: RETRY_DECISION.Retry, reason: `network:${networkCode}` };
  }

  return { decision: RETRY_DECISION.Retry, reason: 'unknown-default-retry' };
}
