import { describe, expect, it } from 'vitest';
import { BodyTooLargeError, enforceBodyCap } from '../src/http/security/body-cap.js';

function requestWithBody(body: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

describe('enforceBodyCap', () => {
  it('passes a body under the cap through, still readable downstream', async () => {
    const request = requestWithBody(JSON.stringify({ text: 'hi' }));
    const result = await enforceBodyCap(request, { limitBytes: 1_000 });
    expect(await result.json()).toStrictEqual({ text: 'hi' });
  });

  it('rejects on an honest, over-cap Content-Length without reading the body', async () => {
    const request = requestWithBody('x'.repeat(2_000));
    await expect(enforceBodyCap(request, { limitBytes: 100 })).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });

  it('rejects a lying/absent Content-Length once the streamed byte count exceeds the cap', async () => {
    const body = 'x'.repeat(2_000);
    const request = requestWithBody(body, { 'content-length': '10' });
    await expect(enforceBodyCap(request, { limitBytes: 100 })).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });

  it('BodyTooLargeError carries the VALIDATION code with httpStatus 413', () => {
    const error = new BodyTooLargeError('too big');
    expect(error.code).toBe('VALIDATION');
    expect(error.httpStatus).toBe(413);
    expect(error.retryable).toBe(false);
  });

  it('passes a null-body request through unchanged', async () => {
    const request = new Request('http://localhost/api/items', { method: 'GET' });
    const result = await enforceBodyCap(request, { limitBytes: 100 });
    expect(result).toBe(request);
  });
});
