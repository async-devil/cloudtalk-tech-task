import { describe, expect, it } from 'vitest';
import {
  applyCorsHeaders,
  corsHeadersFor,
  preflightResponseFor,
} from '../src/http/security/cors.js';

const OPTIONS = { allowedOrigins: ['http://allowed.example.test'] };

describe('corsHeadersFor', () => {
  it('reflects an allow-listed origin, never a wildcard', () => {
    const headers = corsHeadersFor('http://allowed.example.test', OPTIONS);
    expect(headers?.['Access-Control-Allow-Origin']).toBe('http://allowed.example.test');
    expect(headers?.['Access-Control-Allow-Credentials']).toBe('true');
  });

  it('returns undefined for an unlisted origin', () => {
    expect(corsHeadersFor('http://evil.example.test', OPTIONS)).toBeUndefined();
  });

  it('returns undefined for a null (same-origin/no-Origin) request', () => {
    expect(corsHeadersFor(null, OPTIONS)).toBeUndefined();
  });

  it('is structurally unconstructible to a wildcard: no configuration produces "*"', () => {
    const headers = corsHeadersFor('http://allowed.example.test', {
      allowedOrigins: ['http://allowed.example.test', '*'],
    });
    // Even a (misconfigured) allow-list containing the literal '*' string only ever reflects the
    // REQUEST'S origin verbatim — it never emits '*' as the Allow-Origin value itself.
    expect(headers?.['Access-Control-Allow-Origin']).not.toBe('*');
  });
});

describe('applyCorsHeaders / preflightResponseFor', () => {
  it('adds CORS headers to a real response for an allowed origin', () => {
    const response = applyCorsHeaders(new Response('ok'), 'http://allowed.example.test', OPTIONS);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://allowed.example.test');
  });

  it('leaves a response untouched for an unlisted origin', () => {
    const response = applyCorsHeaders(new Response('ok'), 'http://evil.example.test', OPTIONS);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('preflight is a bare 204 carrying the allow-list headers', () => {
    const response = preflightResponseFor('http://allowed.example.test', OPTIONS);
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://allowed.example.test');
  });
});
