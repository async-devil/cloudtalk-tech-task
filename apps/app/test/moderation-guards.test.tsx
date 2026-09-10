/**
 * TASK-0009's own per-route guard: `/moderation` redirects away for a session without
 * `canModerate` — SPEC-0001's own words for S8, "a visitor who types the URL gets the same
 * treatment as S7 — redirected, and refused server-side regardless." Same two-layer shape
 * `catalogue-authoring-guards.test.tsx` already establishes for `/products/new`: a real router
 * navigation (this file), proving `beforeLoad` is actually wired, not merely that a redirect
 * function would be correct if called.
 *
 * COURTESY ONLY, restated here because it is the whole point of testing a UI-only gate: nothing in
 * this file exercises `reviews.moderationList`/`reject`/`restore`'s own `requireModerator` HTTP
 * guard (that is `apps/api`'s own test suite's job) — a session that bypasses this redirect
 * (disabled JS navigation, a stale client) still gets refused server-side.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppRouter } from '../src/router.js';
import {
  type ApiRoute,
  bootstrapPayload,
  type FetchStub,
  jsonResponse,
  pageOf,
  stubApiFetch,
  unauthorizedResponse,
} from './harness/api-responses.js';

let stub: FetchStub | undefined;

afterEach(() => {
  stub?.restore();
  stub = undefined;
  cleanup();
});

function sessionRoute(respond: ApiRoute['respond']): ApiRoute {
  return { method: 'GET', test: (url) => url.pathname === '/api/session/bootstrap', respond };
}

function moderationListRoute(respond: ApiRoute['respond']): ApiRoute {
  return { method: 'GET', test: (url) => url.pathname === '/api/moderation/reviews', respond };
}

async function navigateTo(
  initialPath: string,
  routes: readonly ApiRoute[],
): Promise<{ pathname: string; search: string }> {
  stub = stubApiFetch(routes);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

async function renderRoute(initialPath: string, routes: readonly ApiRoute[]) {
  stub = stubApiFetch(routes);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { queryClient, router };
}

describe('/moderation', () => {
  // UNLIKE `/products/new`: `/moderation` is not covered by `__root.tsx`'s `PUBLIC_ROUTES` prefix
  // list (no `/products`-style prefix applies here), so the ROOT guard itself catches an anonymous
  // visitor first and sends them to `/sign-in` — this route's OWN `beforeLoad` (tested below) never
  // even runs for a session-less request. Both are "the same treatment as S7" in spirit (a visitor
  // cannot reach the screen), just enforced one guard earlier.
  it('an anonymous visitor is redirected to sign-in by the ROOT guard before this route runs', async () => {
    const result = await navigateTo('/moderation', [sessionRoute(() => unauthorizedResponse())]);
    expect(result.pathname).toBe('/sign-in');
  });

  it('a signed-in session WITHOUT canModerate is redirected to the catalogue', async () => {
    const result = await navigateTo('/moderation', [
      sessionRoute(() => jsonResponse(bootstrapPayload({ canModerate: false }))),
    ]);
    expect(result.pathname).toBe('/');
  });

  it('a session with ONLY canManageCatalogue (not canModerate) is still redirected away', async () => {
    const result = await navigateTo('/moderation', [
      sessionRoute(() =>
        jsonResponse(bootstrapPayload({ canManageCatalogue: true, canModerate: false })),
      ),
    ]);
    expect(result.pathname).toBe('/');
  });

  it('a moderator reaches the screen', async () => {
    await renderRoute('/moderation', [
      sessionRoute(() => jsonResponse(bootstrapPayload({ canModerate: true }))),
      moderationListRoute(() => jsonResponse(pageOf([]))),
    ]);
    await screen.findByRole('heading', { name: 'Moderation' });
  });
});
