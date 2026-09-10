import type {
  ProductDetail,
  ProductSummary,
  ReviewSummary,
  SessionBootstrap,
} from '@repo/contracts';
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
    // TASK-0008: defaults to `false` — most existing fixtures have nothing to do with the
    // catalogue-authoring affordance, so a fail-closed default keeps them exercising the same
    // "not a manager" case they always implicitly assumed, unless a test opts in via `overrides`.
    canManageCatalogue: false,
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

/** A page shape matching `pageOf` (`@repo/contracts`) — `{ items, nextCursor }`. */
export function pageOf<T>(items: readonly T[], nextCursor: string | null = null) {
  return { items, nextCursor };
}

export function productSummary(overrides: Partial<ProductSummary> = {}): ProductSummary {
  return {
    slug: 'sony-wh-1000xm5',
    sku: 'AUD-WH1000XM5',
    name: 'Sony WH-1000XM5',
    categoryName: 'Audio',
    priceMinor: 34999,
    currencyCode: 'USD',
    rating: { reviewCount: 12, ratingAverage: 4.3, computedAt: '2026-09-10T00:00:00.000Z' },
    ...overrides,
  };
}

export function productDetail(overrides: Partial<ProductDetail> = {}): ProductDetail {
  return {
    ...productSummary(),
    description: 'Noise-cancelling over-ear headphones.',
    ...overrides,
  };
}

export function reviewSummary(overrides: Partial<ReviewSummary> = {}): ReviewSummary {
  return {
    token: 'rev_AAAAAAAAAAAAAAAAAAAAA',
    rating: 5,
    title: 'Great headphones',
    body: 'Really happy with the noise cancelling and the battery life on these.',
    authorLabel: 'jane',
    authoredByViewer: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * A single routed handler for {@link stubApiFetch}: `test` receives the parsed request URL (so a
 * route can match on pathname alone, or narrow further on `searchParams` — e.g. distinguishing a
 * cursor'd "Load more" call from the first page), `method` narrows further, and `respond` builds
 * the `Response` given the request (for a body-bearing PATCH/POST) — synchronous OR a
 * `Promise<Response>`, so a test can also assert an in-flight state before letting a response
 * resolve.
 */
export interface ApiRoute {
  readonly method: string;
  readonly test: (url: URL) => boolean;
  readonly respond: (request: Request) => Response | Promise<Response>;
}

/**
 * A general-purpose `globalThis.fetch` stub for suites that exercise MORE than the session
 * bootstrap (`stubBootstrapFetch`'s one route) — the catalogue, product-detail and review-submit
 * component tests all talk to several `products`/`reviews` routes in one render. Routes are tried
 * in order; the first `method`+`test` match wins. An unmatched request still fails loudly (the same
 * "unexpected request" rejection `stubBootstrapFetch` uses) rather than resolving to `undefined` —
 * a test that forgot to stub a route should go red, not hang.
 */
export function stubApiFetch(routes: readonly ApiRoute[]): FetchStub {
  const requests: Request[] = [];
  const original = globalThis.fetch;

  vi.stubGlobal('fetch', (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);
    const route = routes.find(
      (candidate) => candidate.method === request.method && candidate.test(url),
    );
    if (route === undefined) {
      return Promise.reject(new Error(`unexpected request: ${request.method} ${request.url}`));
    }
    return Promise.resolve(route.respond(request));
  });

  return {
    requests,
    restore: () => {
      vi.stubGlobal('fetch', original);
    },
  };
}
