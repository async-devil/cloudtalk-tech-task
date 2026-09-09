import { APP_MODE } from '@repo/config';
import { describe, expect, it } from 'vitest';
import { authConfigSlice, parseAuthMethods } from '../src/config-slice.js';
import { AUTH_METHOD } from '../src/methods.js';

const testSchema = authConfigSlice.schema(APP_MODE.Test);
const prodSchema = authConfigSlice.schema(APP_MODE.Production);

describe('parseAuthMethods', () => {
  it('parses a comma-separated list, trimming whitespace', () => {
    const result = parseAuthMethods(' magic-link , password ');
    expect(result).toStrictEqual({
      ok: true,
      methods: [AUTH_METHOD.MagicLink, AUTH_METHOD.Password],
    });
  });

  it('reports the first unknown token', () => {
    expect(parseAuthMethods('magic-link,sms')).toStrictEqual({ ok: false, badToken: 'sms' });
  });

  it('returns an empty list for an empty string (the slice rejects it separately)', () => {
    expect(parseAuthMethods('   ')).toStrictEqual({ ok: true, methods: [] });
  });
});

describe('authConfigSlice', () => {
  it('defaults to magic-link with dev secret/base URL in the test tier', () => {
    const parsed = testSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.AUTH_METHODS).toBe('magic-link');
      expect(parsed.data.AUTH_SECRET.length).toBeGreaterThan(0);
      expect(parsed.data.AUTH_BASE_URL).toBe('http://localhost:3000');
    }
  });

  it('requires AUTH_SECRET and AUTH_BASE_URL in a fail-closed tier', () => {
    const parsed = prodSchema.safeParse({ AUTH_METHODS: 'magic-link' });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown method', () => {
    expect(testSchema.safeParse({ AUTH_METHODS: 'telepathy' }).success).toBe(false);
  });

  it('rejects an empty method list', () => {
    expect(testSchema.safeParse({ AUTH_METHODS: ',' }).success).toBe(false);
  });

  it('requires the full OAuth credential pair when the method is listed', () => {
    expect(testSchema.safeParse({ AUTH_METHODS: 'magic-link,google-oauth' }).success).toBe(false);
    expect(
      testSchema.safeParse({
        AUTH_METHODS: 'magic-link,google-oauth',
        AUTH_GOOGLE_CLIENT_ID: 'id',
        AUTH_GOOGLE_CLIENT_SECRET: 'secret',
      }).success,
    ).toBe(true);
  });

  it('rejects a half-configured OAuth pair even when the method is not listed (all-or-nothing)', () => {
    expect(
      testSchema.safeParse({ AUTH_METHODS: 'magic-link', AUTH_GITHUB_CLIENT_ID: 'only-id' })
        .success,
    ).toBe(false);
  });
});
