import { APP_MODE } from '@repo/config';
import { describe, expect, it } from 'vitest';
import { applySecurityHeaders, buildSecurityHeaders } from '../src/http/security/headers.js';

describe('buildSecurityHeaders', () => {
  it('carries the frozen set without HSTS in the test tier', () => {
    const headers = buildSecurityHeaders(APP_MODE.Test);
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Content-Security-Policy']).toBe("frame-ancestors 'none'");
    expect(headers['Referrer-Policy']).toBe('no-referrer');
    expect(headers['Permissions-Policy']).toContain('camera=()');
    expect(headers['Cache-Control']).toBe('no-store');
    expect(headers['Strict-Transport-Security']).toBeUndefined();
  });

  it('adds Strict-Transport-Security in fail-closed tiers', () => {
    const headers = buildSecurityHeaders(APP_MODE.Production);
    expect(headers['Strict-Transport-Security']).toBe('max-age=31536000; includeSubDomains');
  });
});

describe('applySecurityHeaders', () => {
  it('adds every header to an existing response without disturbing status/body', async () => {
    const original = new Response(JSON.stringify({ ok: true }), { status: 201 });
    const result = applySecurityHeaders(original, APP_MODE.Production);
    expect(result.status).toBe(201);
    expect(result.headers.get('x-content-type-options')).toBe('nosniff');
    expect(result.headers.get('strict-transport-security')).not.toBeNull();
    expect(await result.json()).toStrictEqual({ ok: true });
  });
});
