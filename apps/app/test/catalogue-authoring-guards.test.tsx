/**
 * TASK-0008's own per-route guard: `/products/new` and `/products/$productSlug/edit` redirect away
 * for a session without `canManageCatalogue` — SPEC-0001's own words, "a visitor who types the URL
 * gets the same answer the server gives… the route redirects." Two layers, the same shape
 * `root-guards.test.tsx` already establishes for the ROOT guard: a real router navigation (this
 * file), proving `beforeLoad` is actually wired, not merely that a redirect function would be
 * correct if called.
 *
 * COURTESY ONLY, restated here because it is the whole point of testing a UI-only gate: nothing in
 * this file exercises `products.create`/`products.update`'s own `requireCatalogueManager` HTTP
 * guard (that is `apps/api/test/catalogue-authoring-guards.test.ts`'s job) — a session that
 * bypasses this redirect (disabled JS navigation, a stale client) still gets refused server-side.
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
  productDetail,
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

function productGetRoute(respond: ApiRoute['respond']): ApiRoute {
  return { method: 'GET', test: (url) => /^\/api\/products\/[^/]+$/.test(url.pathname), respond };
}

/** Drives a real navigation and reports where the router ended up — `root-guards.test.tsx`'s own
 * `navigateTo` helper, restated here (this file has no access to that one — it is local to its own
 * test module). */
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

describe('/products/new', () => {
  // NOTE ON WHY THIS IS `/` AND NOT `/sign-in`: `__root.tsx`'s `PUBLIC_ROUTES` marks `/products`
  // as a PREFIX-public route (TASK-0004, for `/products/$productSlug` — visitor surface), and
  // `isPublicRoute`'s prefix match does not distinguish that from `/products/new`, so the ROOT
  // guard never runs for this path at all — THIS route's own `beforeLoad` is the only thing that
  // ever gates it. That is the correct outcome anyway: SPEC-0001 S7 describes exactly one
  // destination for a non-manager, session or no session — "the route redirects to the product or
  // the catalogue" — with no sign-in round trip mentioned, unlike S4's J3.
  it("an anonymous visitor is redirected to the catalogue by this route's own guard", async () => {
    const result = await navigateTo('/products/new', [sessionRoute(() => unauthorizedResponse())]);
    expect(result.pathname).toBe('/');
  });

  it('a signed-in session WITHOUT canManageCatalogue is redirected to the catalogue', async () => {
    const result = await navigateTo('/products/new', [
      sessionRoute(() => jsonResponse(bootstrapPayload({ canManageCatalogue: false }))),
    ]);
    expect(result.pathname).toBe('/');
  });

  it('a catalogue manager reaches the form', async () => {
    await renderRoute('/products/new', [
      sessionRoute(() => jsonResponse(bootstrapPayload({ canManageCatalogue: true }))),
    ]);
    await screen.findByRole('heading', { name: 'New product' });
    expect(screen.getByTestId('product-form-submit')).toBeTruthy();
  });
});

describe('/products/$productSlug/edit', () => {
  it('a signed-in session WITHOUT canManageCatalogue is redirected to the product', async () => {
    const result = await navigateTo('/products/sony-wh-1000xm5/edit', [
      sessionRoute(() => jsonResponse(bootstrapPayload({ canManageCatalogue: false }))),
    ]);
    expect(result.pathname).toBe('/products/sony-wh-1000xm5');
  });

  it('a catalogue manager reaches the form, prefilled from the loaded product', async () => {
    await renderRoute('/products/sony-wh-1000xm5/edit', [
      sessionRoute(() => jsonResponse(bootstrapPayload({ canManageCatalogue: true }))),
      productGetRoute(() => jsonResponse(productDetail())),
    ]);
    await screen.findByRole('heading', { name: 'Edit product' });
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Sony WH-1000XM5');
    // Slug/SKU are shown, disabled, with the immutability reason inline. `.disabled` directly:
    // `@testing-library/jest-dom`'s `toBeDisabled` matcher is not registered in this suite's
    // vitest setup (`product-detail-route.test.tsx`'s own note on the same limitation).
    expect((screen.getByLabelText('Slug') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('SKU') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('The address is fixed so links keep working.')).toBeTruthy();
  });
});
