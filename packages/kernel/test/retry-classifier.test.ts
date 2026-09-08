import { describe, expect, it } from 'vitest';
import {
  type AppError,
  ConflictError,
  classifyRetry,
  ForbiddenError,
  InternalError,
  NotFoundError,
  ProviderError,
  ProviderUnavailableError,
  RateLimitedError,
  RETRY_DECISION,
  RETRYABLE_NETWORK_CODES,
  UnauthorizedError,
  ValidationError,
} from '../src/index.js';

// Table-driven cases for classifyRetry, derived row-for-row from the frozen rule table in
// src/errors/retry-classifier.ts. Reasons are asserted VERBATIM.

interface SubclassCase {
  readonly name: string;
  readonly error: AppError;
  readonly decision: string;
  readonly reason: string;
}

// Rows 1–2: all nine subclasses. Each fixes its own retryability at the definition site, so its
// classification is a property of the type, never of its message.
const subclassCases: readonly SubclassCase[] = [
  {
    name: 'ValidationError',
    error: new ValidationError('x'),
    decision: RETRY_DECISION.Terminal,
    reason: 'app-error-terminal:VALIDATION',
  },
  {
    name: 'UnauthorizedError',
    error: new UnauthorizedError('x'),
    decision: RETRY_DECISION.Terminal,
    reason: 'app-error-terminal:UNAUTHORIZED',
  },
  {
    name: 'ForbiddenError',
    error: new ForbiddenError('x'),
    decision: RETRY_DECISION.Terminal,
    reason: 'app-error-terminal:FORBIDDEN',
  },
  {
    name: 'NotFoundError',
    error: new NotFoundError('x'),
    decision: RETRY_DECISION.Terminal,
    reason: 'app-error-terminal:NOT_FOUND',
  },
  {
    name: 'ConflictError',
    error: new ConflictError('x'),
    decision: RETRY_DECISION.Terminal,
    reason: 'app-error-terminal:CONFLICT',
  },
  {
    name: 'RateLimitedError',
    error: new RateLimitedError('x'),
    decision: RETRY_DECISION.Retry,
    reason: 'app-error-retryable:RATE_LIMITED',
  },
  {
    name: 'ProviderError (default terminal)',
    error: new ProviderError('x'),
    decision: RETRY_DECISION.Terminal,
    reason: 'app-error-terminal:PROVIDER',
  },
  {
    name: 'InternalError (default terminal)',
    error: new InternalError('x'),
    decision: RETRY_DECISION.Terminal,
    reason: 'app-error-terminal:INTERNAL',
  },
  {
    name: 'ProviderUnavailableError',
    error: new ProviderUnavailableError('x'),
    decision: RETRY_DECISION.Retry,
    reason: 'app-error-retryable:PROVIDER',
  },
];

describe('classifyRetry — rows 1–2: kernel subclasses', () => {
  it.each(subclassCases)('$name → $decision / $reason', ({ error, decision, reason }) => {
    expect(classifyRetry(error)).toEqual({ decision, reason });
  });

  it('ProviderError constructed retryable → Retry (row 1, retryability is set at the throw site)', () => {
    expect(classifyRetry(new ProviderError('x', { retryable: true }))).toEqual({
      decision: RETRY_DECISION.Retry,
      reason: 'app-error-retryable:PROVIDER',
    });
  });
});

describe('classifyRetry — rows 3–5: HTTP status', () => {
  it('row 3: status 429 → Retry / http-status:429', () => {
    expect(classifyRetry({ status: 429 })).toEqual({
      decision: RETRY_DECISION.Retry,
      reason: 'http-status:429',
    });
  });

  it.each([400, 404, 422, 499])('row 4: status %i → Terminal / http-status:%i', (status) => {
    expect(classifyRetry({ status })).toEqual({
      decision: RETRY_DECISION.Terminal,
      reason: `http-status:${status}`,
    });
  });

  it.each([500, 503, 599])('row 5: status %i → Retry / http-status:%i', (status) => {
    expect(classifyRetry({ status })).toEqual({
      decision: RETRY_DECISION.Retry,
      reason: `http-status:${status}`,
    });
  });
});

describe('status extraction precedence', () => {
  it('status beats statusCode', () => {
    expect(classifyRetry({ status: 400, statusCode: 500 }).reason).toBe('http-status:400');
  });

  it('statusCode used when status absent', () => {
    expect(classifyRetry({ statusCode: 503 })).toEqual({
      decision: RETRY_DECISION.Retry,
      reason: 'http-status:503',
    });
  });

  it('response.status used when status/statusCode absent (fetch/axios shape)', () => {
    expect(classifyRetry({ response: { status: 429 } })).toEqual({
      decision: RETRY_DECISION.Retry,
      reason: 'http-status:429',
    });
  });

  it.each([
    { label: 'string status', error: { status: '500' } },
    { label: 'float status', error: { status: 4.04 } },
    { label: 'below range', error: { status: 42 } },
    { label: 'above range', error: { status: 700 } },
  ])('non-integer/out-of-range status ($label) is ignored → falls through to unknown-default', ({
    error,
  }) => {
    expect(classifyRetry(error)).toEqual({
      decision: RETRY_DECISION.Retry,
      reason: 'unknown-default-retry',
    });
  });
});

describe('classifyRetry — row 6: retryable network codes', () => {
  // Iterate the exported set itself — never copy the list (keeps test + classifier in lockstep).
  it.each([...RETRYABLE_NETWORK_CODES])('%s → Retry / network:%s', (code) => {
    expect(classifyRetry({ code })).toEqual({
      decision: RETRY_DECISION.Retry,
      reason: `network:${code}`,
    });
  });

  it('ENOTFOUND is NOT a known-transient code → falls to row 7 (unknown-default-retry)', () => {
    expect(RETRYABLE_NETWORK_CODES.has('ENOTFOUND')).toBe(false);
    expect(classifyRetry({ code: 'ENOTFOUND' })).toEqual({
      decision: RETRY_DECISION.Retry,
      reason: 'unknown-default-retry',
    });
  });
});

describe('classifyRetry — row 7: unknown default', () => {
  it.each([
    { label: 'plain Error', error: new Error('boom') },
    { label: 'string throwable', error: 'plain failure' },
    { label: 'null', error: null },
    { label: 'undefined', error: undefined },
    { label: 'empty object', error: {} },
  ])('$label → Retry / unknown-default-retry', ({ error }) => {
    expect(classifyRetry(error)).toEqual({
      decision: RETRY_DECISION.Retry,
      reason: 'unknown-default-retry',
    });
  });
});

describe('classifyRetry — precedence: AppError beats status (first-match-wins)', () => {
  it('an AppError that also carries a status property is classified by rows 1–2, not by status', () => {
    // A NotFoundError (terminal) with a foreign-looking retryable 503 attached must stay terminal:
    // the type-first rule wins over status extraction.
    const error = Object.assign(new NotFoundError('missing'), { status: 503 });
    expect(classifyRetry(error)).toEqual({
      decision: RETRY_DECISION.Terminal,
      reason: 'app-error-terminal:NOT_FOUND',
    });
  });
});
