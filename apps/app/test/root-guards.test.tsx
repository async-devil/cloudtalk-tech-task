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
    // TASK-0004: the catalogue (exact `/`) and every product-detail path (including the S4 form's
    // `?review=new`/`edit` search-param state, which does not change the pathname) are Visitor
    // surface — SPEC-0001's J1, "no session at any point".
    expect(isPublicRoute('/')).toBe(true);
    expect(isPublicRoute('/products/sony-wh-1000xm5')).toBe(true);
  });

  it('does not match a path that merely starts with a public route name', () => {
    expect(isPublicRoute('/sign-in-elsewhere')).toBe(false);
    expect(isPublicRoute('/productsx')).toBe(false);
  });

  it('declares the public surface in one place', () => {
    expect(PUBLIC_ROUTES).toEqual([SIGN_IN_ROUTE, '/auth/callback', '/', '/products']);
  });
});

describe('the root guard, through a real router navigation', () => {
  /**
   * The attempted location is asserted with a SEARCH STRING on it, and that detail is
   * load-bearing — it is what tells this assertion apart from the GUARD's redirect landing by
   * coincidence rather than by carrying the right `returnTo`.
   *
   * The 401 the stub returns does NOT also reach `shared/errors`' cache-level subscriber
   * (`installUnauthorizedRedirect`): that subscriber deliberately excludes the session bootstrap
   * query itself (TASK-0004, `unauthorized-redirect.test.ts`'s own test for it) — a public page's
   * anonymous bootstrap 401 is its NORMAL answer, not a "session expired" signal, and treating it
   * as one is exactly the bug that exclusion exists to prevent. This route (`/some-protected-place`)
   * is not public, so ONLY the guard's own `beforeLoad` redirect is what this test is proving.
   */
  it('redirects an unauthenticated visit into /sign-in carrying the exact attempted location', async () => {
    stub = stubBootstrapFetch(() => unauthorizedResponse());

    // TASK-0004 made `/` (and `/products`) Visitor surface (SPEC-0001 J1), so neither can stand
    // in for "a protected route" any more — this suite's job is proving the GUARD MECHANISM still
    // works, not any particular screen's guardedness, so it targets a path that matches no route
    // at all (never added to `PUBLIC_ROUTES`, and root's `beforeLoad` runs ahead of route matching
    // either way — a not-found leaf does not skip an ancestor's `beforeLoad`).
    const location = await navigateTo('/some-protected-place?filter=open');

    expect(location.pathname).toBe(SIGN_IN_ROUTE);
    expect(decodeURIComponent(location.search)).toContain(
      'returnTo=/some-protected-place?filter=open',
    );
  });

  it('lets a session reach a route that is not on PUBLIC_ROUTES', async () => {
    stub = stubBootstrapFetch(() => jsonResponse(bootstrapPayload()));

    const location = await navigateTo('/some-protected-place');

    // Not redirected to /sign-in — the guard let the visit through once a session resolved. The
    // path itself renders as a 404 (no route matches it), which is beside this test's point.
    expect(location.pathname).toBe('/some-protected-place');
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
