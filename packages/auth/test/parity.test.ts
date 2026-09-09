import { isAppError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';
import type { AuthHandle, SessionCookieAttributes } from '../src/factory.js';
import { AUTH_METHOD } from '../src/methods.js';
import { assertAuthMethodParity, assertSessionCookiePolicy } from '../src/parity.js';

const PINNED_COOKIE: SessionCookieAttributes = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  secure: true,
};

function handleWith(
  mountedMethods: AuthHandle['mountedMethods'],
  sessionCookieAttributes: SessionCookieAttributes = PINNED_COOKIE,
): AuthHandle {
  return {
    handler: () => Promise.resolve(new Response()),
    api: { getSession: () => Promise.resolve(null) },
    mountedMethods,
    sessionCookieAttributes,
  };
}

describe('assertAuthMethodParity', () => {
  it('passes when mounted and claimed sets are equal (order-independent)', () => {
    const handle = handleWith([AUTH_METHOD.Password, AUTH_METHOD.MagicLink]);
    expect(() =>
      assertAuthMethodParity(handle, [AUTH_METHOD.MagicLink, AUTH_METHOD.Password]),
    ).not.toThrow();
  });

  it('throws a named error listing the delta when a method is mounted but not claimed', () => {
    const handle = handleWith([AUTH_METHOD.MagicLink, AUTH_METHOD.Password]);
    try {
      assertAuthMethodParity(handle, [AUTH_METHOD.MagicLink]);
      expect.unreachable('parity should have failed');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      const details = (error as { details?: Record<string, unknown> }).details ?? {};
      expect(details.mountedButNotClaimed).toStrictEqual([AUTH_METHOD.Password]);
      expect(details.claimedButNotMounted).toStrictEqual([]);
    }
  });

  it('throws when a method is claimed but not mounted (the reference H2 drift, reversed)', () => {
    const handle = handleWith([AUTH_METHOD.MagicLink]);
    try {
      assertAuthMethodParity(handle, [AUTH_METHOD.MagicLink, AUTH_METHOD.GoogleOAuth]);
      expect.unreachable('parity should have failed');
    } catch (error) {
      const details = (error as { details?: Record<string, unknown> }).details ?? {};
      expect(details.claimedButNotMounted).toStrictEqual([AUTH_METHOD.GoogleOAuth]);
    }
  });
});

describe('assertSessionCookiePolicy', () => {
  it('passes when the pinned attributes match and Secure tracks the expected scheme', () => {
    const handle = handleWith([AUTH_METHOD.MagicLink], { ...PINNED_COOKIE, secure: true });
    expect(() => assertSessionCookiePolicy(handle, { expectSecure: true })).not.toThrow();
  });

  it('passes with Secure=false on a localhost (http) dev boot', () => {
    const handle = handleWith([AUTH_METHOD.MagicLink], { ...PINNED_COOKIE, secure: false });
    expect(() => assertSessionCookiePolicy(handle, { expectSecure: false })).not.toThrow();
  });

  it('throws a named error when Secure stops tracking the scheme (http base but Secure=true)', () => {
    const handle = handleWith([AUTH_METHOD.MagicLink], { ...PINNED_COOKIE, secure: true });
    try {
      assertSessionCookiePolicy(handle, { expectSecure: false });
      expect.unreachable('cookie policy should have failed');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
    }
  });

  it.each([
    ['httpOnly dropped', { ...PINNED_COOKIE, httpOnly: false }],
    ['sameSite widened to none', { ...PINNED_COOKIE, sameSite: 'none' as const }],
    ['path narrowed', { ...PINNED_COOKIE, path: '/app' }],
  ])('throws when %s', (_name, attributes) => {
    const handle = handleWith([AUTH_METHOD.MagicLink], attributes);
    expect(() => assertSessionCookiePolicy(handle, { expectSecure: true })).toThrow();
  });
});
