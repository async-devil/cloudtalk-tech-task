import { isAppError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';
import {
  AUTH_SIGNUP_POSTURE,
  assertSignupAllowed,
  parseSignupAllowedEmails,
} from '../src/signup-posture.js';

describe('parseSignupAllowedEmails', () => {
  it('normalizes to lowercase, trims, and drops empty tokens', () => {
    expect(parseSignupAllowedEmails(' Alice@Example.com , bob@example.com ,, ')).toStrictEqual(
      new Set(['alice@example.com', 'bob@example.com']),
    );
  });

  it('returns an empty set for undefined', () => {
    expect(parseSignupAllowedEmails(undefined)).toStrictEqual(new Set());
  });
});

describe('assertSignupAllowed', () => {
  it('admits any address under open posture', () => {
    expect(() =>
      assertSignupAllowed({
        posture: AUTH_SIGNUP_POSTURE.Open,
        allowedEmails: new Set(),
        email: 'anyone@example.com',
      }),
    ).not.toThrow();
  });

  it('admits a listed address under allowlist posture, case-insensitively', () => {
    expect(() =>
      assertSignupAllowed({
        posture: AUTH_SIGNUP_POSTURE.Allowlist,
        allowedEmails: new Set(['alice@example.com']),
        email: 'Alice@Example.com',
      }),
    ).not.toThrow();
  });

  it('rejects a non-listed address under allowlist posture with a ForbiddenError', () => {
    try {
      assertSignupAllowed({
        posture: AUTH_SIGNUP_POSTURE.Allowlist,
        allowedEmails: new Set(['alice@example.com']),
        email: 'mallory@example.com',
      });
      expect.unreachable('assertSignupAllowed should have thrown');
    } catch (error) {
      expect(isAppError(error) && error.code === 'FORBIDDEN').toBe(true);
    }
  });
});
