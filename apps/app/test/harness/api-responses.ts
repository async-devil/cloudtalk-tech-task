import type { SessionBootstrap } from '@repo/contracts';
import { ERROR_CODE, type ErrorCode } from '@repo/kernel';
import { vi } from 'vitest';

/**
 * The ONE test double in this suite: `globalThis.fetch`.
 *
 * Everything above it is the real thing — the real `OpenAPILink` built from the real
 * `appContract`, the real `toApiError` mapping, the real Query cache, the real router. That is
 * deliberate: a hand-built fake `apiClient` would be shaped by whatever the code under test
 * expects, and would agree with it no matter what either of them did. Stubbing the transport is
 * the lowest level at which the test can lie, so it is the only level where it does.
 */

export function bootstrapPayload(overrides: Partial<SessionBootstrap> = {}): SessionBootstrap {
  return {
    userToken: 'usr_AAAAAAAAAAAAAAAAAAAAA',
    onboardingComplete: true,
    ...overrides,
  };
}

export interface FetchStub {
  /** Every request the app made, in order — asserted on directly (URL, method, credentials). */
  readonly requests: Request[];
  restore(): void;
}

/** Installs a `globalThis.fetch` that answers `GET /api/session/bootstrap` with `response` and
 * fails loudly for anything else, so an unexpected call is a red test rather than a silent
 * `undefined`. */
export function stubBootstrapFetch(response: () => Response): FetchStub {
  const requests: Request[] = [];
  const original = globalThis.fetch;

  vi.stubGlobal('fetch', (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);
    if (new URL(request.url).pathname === '/api/session/bootstrap') {
      return Promise.resolve(response());
    }
    return Promise.reject(new Error(`unexpected request: ${request.method} ${request.url}`));
  });

  return {
    requests,
    restore: () => {
      vi.stubGlobal('fetch', original);
    },
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The api's uniform wire error shape (`@repo/contracts`' `apiErrorShape`) — written out here
 * rather than imported from a helper, so these suites assert against the bytes the backend
 * actually sends. */
export function wireError(code: ErrorCode, message: string, status: number): Response {
  return jsonResponse({ code, message }, status);
}

export function unauthorizedResponse(): Response {
  return wireError(ERROR_CODE.Unauthorized, 'authentication required', 401);
}
