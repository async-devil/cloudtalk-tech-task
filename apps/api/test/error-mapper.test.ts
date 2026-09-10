import process from 'node:process';
import type { ApiErrorShape } from '@repo/contracts';
import {
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  ProviderError,
  ProviderUnavailableError,
  RateLimitedError,
  UnauthorizedError,
  ValidationError,
} from '@repo/kernel';
import { describe, expect, it } from 'vitest';
import {
  API_HTTP_ERROR_INSTRUMENT,
  classifyError,
  errorResponseFor,
  finalizeErrorResponse,
  type HttpRequestContext,
  toOrpcError,
} from '../src/http/error-mapper.js';
import { createHttpHandler, type HttpHandlerDeps } from '../src/http/index.js';
import { API_HTTP_REQUEST_INSTRUMENT } from '../src/runtime/build-app.js';

/** Destination-seam capture — the facade logger's default destination is `process.stdout`
 * intercepted here, since the process logger internals
 * live in `@repo/observability` and this test may not reach across the package boundary
 * (ADR-0001). */
function captureStdout(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // biome-ignore lint/suspicious/noExplicitAny: matching Node's overloaded `write` signature
  (process.stdout as any).write = (chunk: any, ...rest: any[]) => {
    lines.push(String(chunk));
    return original(chunk, ...rest);
  };
  return {
    lines,
    restore(): void {
      process.stdout.write = original;
    },
  };
}

function jsonLines(lines: readonly string[]): Array<Record<string, unknown>> {
  return lines
    .flatMap((chunk) => chunk.split('\n'))
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .filter((parsed): parsed is Record<string, unknown> => parsed !== undefined);
}

const context: HttpRequestContext = { routeTemplate: 'other', method: 'GET' };

interface WireCase {
  readonly name: string;
  readonly error: unknown;
  readonly code: ApiErrorShape['code'];
  readonly httpStatus: number;
  readonly messageIsGeneric: boolean;
}

// spec "wire shape": all nine subclasses -> { code, message, details? } with the class's
// httpStatus; 5xx bodies carry the generic message.
const wireCases: readonly WireCase[] = [
  {
    name: 'ValidationError',
    error: new ValidationError('bad field'),
    code: 'VALIDATION',
    httpStatus: 400,
    messageIsGeneric: false,
  },
  {
    name: 'UnauthorizedError',
    error: new UnauthorizedError('no token'),
    code: 'UNAUTHORIZED',
    httpStatus: 401,
    messageIsGeneric: false,
  },
  {
    name: 'ForbiddenError',
    error: new ForbiddenError('nope'),
    code: 'FORBIDDEN',
    httpStatus: 403,
    messageIsGeneric: false,
  },
  {
    name: 'NotFoundError',
    error: new NotFoundError('missing'),
    code: 'NOT_FOUND',
    httpStatus: 404,
    messageIsGeneric: false,
  },
  {
    name: 'ConflictError',
    error: new ConflictError('conflict'),
    code: 'CONFLICT',
    httpStatus: 409,
    messageIsGeneric: false,
  },
  {
    name: 'RateLimitedError',
    error: new RateLimitedError('slow down'),
    code: 'RATE_LIMITED',
    httpStatus: 429,
    messageIsGeneric: false,
  },
  {
    name: 'ProviderError',
    error: new ProviderError('upstream down'),
    code: 'PROVIDER',
    httpStatus: 502,
    messageIsGeneric: true,
  },
  {
    name: 'ProviderUnavailableError',
    error: new ProviderUnavailableError('upstream unavailable'),
    code: 'PROVIDER',
    httpStatus: 503,
    messageIsGeneric: true,
  },
  {
    name: 'InternalError',
    error: new InternalError('boom'),
    code: 'INTERNAL',
    httpStatus: 500,
    messageIsGeneric: true,
  },
];

describe('classifyError (ADR-0008): wire shape table', () => {
  it.each(wireCases)('$name -> { code: $code, httpStatus: $httpStatus }', ({
    error,
    code,
    httpStatus,
    messageIsGeneric,
  }) => {
    const classified = classifyError(error);
    expect(classified.httpStatus).toBe(httpStatus);
    expect(classified.wire.code).toBe(code);
    if (messageIsGeneric) {
      expect(classified.wire.message).toBe('Internal server error');
    } else {
      expect(classified.wire.message).toBe((error as Error).message);
    }
  });

  it('a non-AppError throwable classifies as INTERNAL/500 generic', () => {
    const classified = classifyError(new Error('some foreign failure'));
    expect(classified.httpStatus).toBe(500);
    expect(classified.wire).toEqual({ code: 'INTERNAL', message: 'Internal server error' });
  });

  it('carries details when the AppError supplies them', () => {
    const classified = classifyError(new ValidationError('bad', { details: { field: 'x' } }));
    expect(classified.wire.details).toEqual({ field: 'x' });
  });

  // Review, 2026-09-09: genericizing `message` alone left `details` on the body, so a 5xx still
  // shipped the internal fields that explain it — the fail-closed session error's `identityId`,
  // a row parse's column paths. "Internals never leak" is the whole 5xx contract; assert the
  // BODY, not just the message.
  it('DROPS details on a 5xx: the whole body is code + generic message', () => {
    const classified = classifyError(
      new InternalError('no app_user row for identity', { details: { identityId: 'idn_secret' } }),
    );
    expect(classified.httpStatus).toBe(500);
    expect(classified.wire).toEqual({ code: 'INTERNAL', message: 'Internal server error' });
    expect(JSON.stringify(classified.wire)).not.toContain('idn_secret');
  });

  it('DROPS details on a 502 provider failure too (every 5xx, not just INTERNAL)', () => {
    const classified = classifyError(
      new ProviderError('mailer rejected', { details: { upstreamAccountId: 'acct_secret' } }),
    );
    expect(classified.wire).toEqual({ code: 'PROVIDER', message: 'Internal server error' });
  });

  it('KEEPS details on a 4xx: they are the caller input a 400 exists to explain', () => {
    const classified = classifyError(
      new ValidationError('bad', { details: { issues: [{ path: 'rating' }] } }),
    );
    expect(classified.wire.details).toEqual({ issues: [{ path: 'rating' }] });
  });
});

describe('api.http.error / api.http.request counter-dimension identity', () => {
  it('share the identical allowedAttributes set', () => {
    expect([...API_HTTP_ERROR_INSTRUMENT.allowedAttributes].sort()).toEqual(
      [...API_HTTP_REQUEST_INSTRUMENT.allowedAttributes].sort(),
    );
  });
});

describe('toOrpcError (spec ): exactly one log per failing request', () => {
  it('logs exactly one structured line carrying code/reason/cause', () => {
    const capture = captureStdout();
    let orpcError: unknown;
    try {
      orpcError = toOrpcError(new NotFoundError('note missing'), context);
    } finally {
      capture.restore();
    }

    const lines = jsonLines(capture.lines);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      code: 'NOT_FOUND',
      reason: 'app-error-terminal:NOT_FOUND',
      level: 50,
    });
    expect((orpcError as { code: string }).code).toBe('NOT_FOUND');
  });
});

describe('finalizeErrorResponse (spec ): the two integration points are mutually exclusive', () => {
  it('a response already shaped by toOrpcError passes through with NO additional log', () => {
    const orpcError = toOrpcError(new ConflictError('dup'), context) as unknown as {
      status: number;
      data: ApiErrorShape;
    };
    const preShaped = new Response(
      JSON.stringify({ code: orpcError.data.code, data: orpcError.data }),
      {
        status: orpcError.status,
      },
    );

    const capture = captureStdout();
    return finalizeErrorResponse(preShaped, context).then(async (response) => {
      capture.restore();
      expect(jsonLines(capture.lines)).toHaveLength(0);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ code: 'CONFLICT', message: 'dup' });
    });
  });

  it("oRPC's own BAD_REQUEST (no handler ran) maps to VALIDATION/400 and logs exactly once", async () => {
    const oRpcOwnError = new Response(JSON.stringify({ code: 'BAD_REQUEST' }), { status: 400 });
    const capture = captureStdout();
    const response = await finalizeErrorResponse(oRpcOwnError, context);
    capture.restore();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: 'VALIDATION',
      message: 'Input validation failed',
    });
    expect(jsonLines(capture.lines)).toHaveLength(1);
  });

  // Review, 2026-09-09: this parse used to be unguarded, so a non-JSON upstream body (a proxy's
  // HTML error page, a truncated response) rejected and threw straight out of the handler —
  // past the uniform wire shape, past this error signal, past every header the caller wraps
  // around the finalized response.
  it('a non-JSON error body still finalizes to the uniform shape (and logs once)', async () => {
    const notJson = new Response('<html>502 Bad Gateway</html>', { status: 502 });
    const capture = captureStdout();
    const response = await finalizeErrorResponse(notJson, context);
    capture.restore();

    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ code: 'INTERNAL', message: 'Internal server error' });
    expect(jsonLines(capture.lines)).toHaveLength(1);
  });

  it('an empty error body finalizes rather than rejecting', async () => {
    const empty = new Response(null, { status: 500 });
    const response = await finalizeErrorResponse(empty, context);
    expect(await response.json()).toEqual({ code: 'INTERNAL', message: 'Internal server error' });
  });

  it('a passthrough 2xx response is untouched', async () => {
    const ok = new Response(JSON.stringify({ id: '1' }), { status: 200 });
    const response = await finalizeErrorResponse(ok, context);
    expect(response).toBe(ok);
  });
});

describe('errorResponseFor (finding #4): session-resolution throws are mapped AND observed', () => {
  it('maps an AppError to its wire shape and logs exactly one line', () => {
    const capture = captureStdout();
    let response: Response;
    try {
      response = errorResponseFor(new ForbiddenError('no membership'), context);
    } finally {
      capture.restore();
    }
    expect(response.status).toBe(403);
    const lines = jsonLines(capture.lines);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ code: 'FORBIDDEN', level: 50 });
  });

  it('a resolveRequestSession throw becomes an in-band 403 (not a mount-onError fallthrough)', async () => {
    // The mounted oRPC handler resolves the session BEFORE any handler runs (http/index.ts), so a
    // no-membership ForbiddenError would otherwise bypass this observed boundary. A session dep
    // whose getSession throws stands in for that throw — the unit under test is this boundary,
    // not resolveRequestSession's own lookup logic.
    const deps: HttpHandlerDeps = {
      session: {
        api: { getSession: () => Promise.reject(new ForbiddenError('no membership')) },
        db: {} as never,
      },
    };
    const handler = createHttpHandler(deps);
    const capture = captureStdout();
    const response = await handler(new Request('http://localhost/api/items', { method: 'POST' }));
    capture.restore();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 'FORBIDDEN', message: 'no membership' });
    expect(jsonLines(capture.lines)).toHaveLength(1);
  });
});

describe('unmatched route (spec ): uniform 404 wire shape, deliberately no failSpan', () => {
  it('returns the uniform wire shape and emits zero logs', async () => {
    const handler = createHttpHandler({});
    const capture = captureStdout();
    const response = await handler(new Request('http://localhost/api/nope'));
    capture.restore();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: 'NOT_FOUND', message: 'Not Found' });
    expect(jsonLines(capture.lines)).toHaveLength(0);
  });
});
