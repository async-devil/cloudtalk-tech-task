import { isAppError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';
import { MagicLinkSendFailedError } from '../src/errors.js';
import { AUTH_ROUTE_GROUP, routeGroupOf } from '../src/internal/observability.js';
import { purgeExpiredAuthRows } from '../src/retention.js';

describe('MagicLinkSendFailedError', () => {
  it('is a retryable 503 AppError carrying the funnel wire code', () => {
    const error = new MagicLinkSendFailedError('send failed');
    expect(isAppError(error)).toBe(true);
    expect(error.code).toBe('MAGIC_LINK_SEND_FAILED');
    expect(error.httpStatus).toBe(503);
    expect(error.retryable).toBe(true);
  });
});

describe('routeGroupOf', () => {
  it('maps better-auth paths to the bounded route-group set', () => {
    expect(routeGroupOf('/api/auth/sign-in/magic-link')).toBe(AUTH_ROUTE_GROUP.SignIn);
    expect(routeGroupOf('/api/auth/callback/google')).toBe(AUTH_ROUTE_GROUP.Callback);
    expect(routeGroupOf('/api/auth/get-session')).toBe(AUTH_ROUTE_GROUP.Session);
    expect(routeGroupOf('/api/auth/anything-else')).toBe(AUTH_ROUTE_GROUP.Other);
  });
});

describe('purgeExpiredAuthRows floors', () => {
  const db = {} as never; // never reached: the floor guard throws before any query

  it('rejects a non-positive session horizon', async () => {
    await expect(
      purgeExpiredAuthRows({ db, sessionRetainMs: 0, verificationRetainMs: 1 }),
    ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === 'VALIDATION');
  });

  it('rejects a non-positive verification horizon', async () => {
    await expect(
      purgeExpiredAuthRows({ db, sessionRetainMs: 1, verificationRetainMs: -1 }),
    ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === 'VALIDATION');
  });
});
