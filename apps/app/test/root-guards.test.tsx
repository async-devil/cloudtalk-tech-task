/**
 * THE GUARD PROOF: no session ⇒ `/sign-in` with a `returnTo` param.
 *
 * Two layers, on purpose:
 *   - the pure decision (`guardRedirectFor`), asserted directly;
 *   - a REAL router navigation through the real route tree, the real Query cache and the real oRPC
 *     client, with only `globalThis.fetch` stubbed. That is what proves `beforeLoad` is actually
 *     wired to the decision — a pure function nobody calls redirects nobody.
 */
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppRouter } from '../src/router.js';
import {
  guardRedirectFor,
  isPublicRoute,
  PUBLIC_ROUTES,
  SIGN_IN_ROUTE,
} from '../src/routes/__root.js';
import {
  bootstrapPayload,
  type FetchStub,
  jsonResponse,
  stubBootstrapFetch,
  unauthorizedResponse,
} from './harness/api-responses.js';

let stub: FetchStub | undefined;

afterEach(() => {
  stub?.restore();
  stub = undefined;
});

/** Drives a real navigation to `initialPath` and reports where the router ended up. */
async function navigateTo(initialPath: string): Promise<{ pathname: string; search: string }> {
  const queryClient = new QueryClient({
    // A test must not silently wait out a retry budget; the production options set this too.
    defaultOptions: { queries: { retry: false } },
  });
  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  await router.load();
  return {
    pathname: router.state.location.pathname,
    search: router.state.location.searchStr,
  };
}

describe('guardRedirectFor — the session guard', () => {
  it('sends a request with no session to /sign-in, carrying the attempted location', () => {
    expect(
      guardRedirectFor({ pathname: '/', returnTo: '/?filter=open', bootstrap: undefined }),
    ).toEqual({ to: SIGN_IN_ROUTE, search: { returnTo: '/?filter=open' } });
  });

  it('lets a session through', () => {
    expect(
      guardRedirectFor({ pathname: '/', returnTo: '/', bootstrap: bootstrapPayload() }),
    ).toBeUndefined();
  });
});

describe('PUBLIC_ROUTES', () => {
  it('matches the declared public routes and their subpaths', () => {
    expect(isPublicRoute(SIGN_IN_ROUTE)).toBe(true);
    expect(isPublicRoute('/auth/callback/magic-link')).toBe(true);
  });

  it('does not match a path that merely starts with a public route name', () => {
    expect(isPublicRoute('/sign-in-elsewhere')).toBe(false);
    expect(isPublicRoute('/')).toBe(false);
  });

  it('declares the public surface in one place', () => {
    expect(PUBLIC_ROUTES).toEqual([SIGN_IN_ROUTE, '/auth/callback']);
  });
});

describe('the root guard, through a real router navigation', () => {
  /**
   * The attempted location is asserted with a SEARCH STRING on it, and that detail is
   * load-bearing. The 401 the stub returns also reaches the cache-level subscriber, which
   * redirects to `/sign-in` too — reading `returnTo` from `window.location`, which in this
   * environment is a bare `/`. Verified by mutation: with the session guard's redirect deleted,
   * an assertion of `returnTo=/` still passed (the subscriber had done it), while the exact
   * `/?filter=open` below went red. A test that cannot tell the two mechanisms apart is a test
   * that proves neither.
   */
  it('redirects an unauthenticated visit into /sign-in carrying the exact attempted location', async () => {
    stub = stubBootstrapFetch(() => unauthorizedResponse());

    const location = await navigateTo('/?filter=open');

    expect(location.pathname).toBe(SIGN_IN_ROUTE);
    expect(decodeURIComponent(location.search)).toContain('returnTo=/?filter=open');
  });

  it('lets a session reach the protected route', async () => {
    stub = stubBootstrapFetch(() => jsonResponse(bootstrapPayload()));

    const location = await navigateTo('/');

    expect(location.pathname).toBe('/');
  });

  it('renders /sign-in without ever calling the api — a public route asks no questions', async () => {
    stub = stubBootstrapFetch(() => unauthorizedResponse());

    const location = await navigateTo(SIGN_IN_ROUTE);

    expect(location.pathname).toBe(SIGN_IN_ROUTE);
    // The point of `PUBLIC_ROUTES`: no bootstrap request is made at all. A guard that fetched
    // first and ignored the answer would pass every assertion above and still cost every
    // signed-out visitor a 401 round trip on the one page they can use.
    expect(stub.requests).toHaveLength(0);
  });
});
