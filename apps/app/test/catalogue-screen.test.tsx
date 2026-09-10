import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppRouter } from '../src/router.js';
import {
  type ApiRoute,
  type FetchStub,
  jsonResponse,
  pageOf,
  productSummary,
  stubApiFetch,
  unauthorizedResponse,
  wireError,
} from './harness/api-responses.js';

/**
 * S2 — the catalogue (SPEC-0001), driven through a REAL router navigation to `/` (the same shape
 * `router-error-boundary.test.tsx`/`root-guards.test.tsx` already use): `/` is public
 * (`__root.tsx`'s `PUBLIC_ROUTES`), so these suites never need a session to reach it, matching J1
 * ("no session at any point").
 */

let stub: FetchStub | undefined;

afterEach(() => {
  stub?.restore();
  stub = undefined;
  cleanup();
  vi.useRealTimers();
});

const SESSION_ROUTE: ApiRoute = {
  method: 'GET',
  test: (url) => url.pathname === '/api/session/bootstrap',
  respond: () => unauthorizedResponse(),
};

function productsRoute(respond: ApiRoute['respond']): ApiRoute {
  return { method: 'GET', test: (url) => url.pathname === '/api/products', respond };
}

async function renderCatalogue(initialPath: string, extraRoutes: readonly ApiRoute[]) {
  stub = stubApiFetch([SESSION_ROUTE, ...extraRoutes]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  await router.load();
  // Mirrors `main.tsx`'s own composition root exactly: `RouterProvider` alone gives loaders
  // `context.queryClient`, but a component's OWN `useQuery`/`useInfiniteQuery` (every hook in
  // `catalogue`/`product-detail`) reads React context instead, which only `QueryClientProvider`
  // supplies.
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { queryClient, router };
}

describe('CatalogueScreen — loading, product card, unrated product', () => {
  it('renders skeleton cards while the list is in flight, with no layout-shifting text', async () => {
    // Never resolves — asserts the loading frame only.
    await renderCatalogue('/', [
      productsRoute(
        () =>
          new Promise<Response>(() => {
            // Deliberately never settles.
          }),
      ),
    ]);

    await screen.findByText('Catalogue');
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('renders a product card: name, category, price, stars + numeric average + count, and "rated … ago"', async () => {
    await renderCatalogue('/', [productsRoute(() => jsonResponse(pageOf([productSummary()])))]);

    await screen.findByText('Sony WH-1000XM5');
    expect(screen.getByText('Audio')).toBeTruthy();
    expect(screen.getByText(/349\.99/)).toBeTruthy();
    expect(screen.getByText('4.3 (12)')).toBeTruthy();
    expect(screen.getByText(/^rated /)).toBeTruthy();

    // Keyboard contract: the whole card is a real <a>, not a div with a click handler.
    const link = screen.getByRole('link', { name: /Sony WH-1000XM5/ });
    expect(link.getAttribute('href')).toBe('/products/sony-wh-1000xm5');
  });

  it('shows "No reviews yet" for an unrated product — never 0 or 0.0 (rule 14)', async () => {
    await renderCatalogue('/', [
      productsRoute(() =>
        jsonResponse(
          pageOf([
            productSummary({ rating: { reviewCount: 0, ratingAverage: null, computedAt: null } }),
          ]),
        ),
      ),
    ]);

    await screen.findByText('No reviews yet');
    expect(screen.queryByText(/0\.0/)).toBeNull();
    expect(screen.queryByText(/^0$/)).toBeNull();
  });
});

describe('CatalogueScreen — empty, error and pagination states', () => {
  it('empty (no products): a plain statement, no filter echoed', async () => {
    await renderCatalogue('/', [productsRoute(() => jsonResponse(pageOf([])))]);
    await screen.findByText('No products in the catalogue yet.');
  });

  it('empty (filter matched nothing): echoes the filter back and offers a clear-filters action', async () => {
    await renderCatalogue('/?query=doesnotexist', [productsRoute(() => jsonResponse(pageOf([])))]);
    await screen.findByText(/No products match/);
    expect(screen.getByText(/“doesnotexist”/)).toBeTruthy();
    // TWO "Clear filters" buttons render at once here — the filter form's own (always present
    // while a filter is active) and the empty-state's — so this asserts at least one exists rather
    // than picking a single element `getByRole` would refuse as ambiguous.
    expect(screen.getAllByRole('button', { name: 'Clear filters' }).length).toBeGreaterThan(0);
  });

  it('error: the message-map copy for the code, with a retry action', async () => {
    await renderCatalogue('/', [productsRoute(() => wireError('INTERNAL', 'boom', 500))]);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Something went wrong. Please try again.');
    expect(alert.textContent).not.toContain('boom');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('Load more appends the next cursor page — items accumulate rather than replace', async () => {
    await renderCatalogue('/', [
      {
        method: 'GET',
        test: (url) => url.pathname === '/api/products',
        respond: (request) => {
          const cursor = new URL(request.url).searchParams.get('cursor');
          if (cursor === null) {
            return jsonResponse(
              pageOf([productSummary({ slug: 'first', name: 'First Product' })], 'page-2'),
            );
          }
          return jsonResponse(pageOf([productSummary({ slug: 'second', name: 'Second Product' })]));
        },
      },
    ]);

    await screen.findByText('First Product');
    expect(screen.queryByText('Second Product')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await screen.findByText('Second Product');
    // The first page's item is still there — accumulated, not replaced.
    expect(screen.getByText('First Product')).toBeTruthy();
    // Exhausted: no more "Load more" once the last page reports nextCursor: null.
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});

describe('CatalogueScreen — the URL is the state', () => {
  it('a deep link with query/category/sort params is honoured on first render', async () => {
    let seenSearch: URLSearchParams | undefined;
    await renderCatalogue('/?query=headphones&category=Audio&sort=name', [
      {
        method: 'GET',
        test: (url) => url.pathname === '/api/products',
        respond: (request) => {
          seenSearch = new URL(request.url).searchParams;
          return jsonResponse(pageOf([productSummary()]));
        },
      },
    ]);

    await screen.findByText('Sony WH-1000XM5');
    expect(seenSearch?.get('query')).toBe('headphones');
    expect(seenSearch?.get('category')).toBe('Audio');
    expect(seenSearch?.get('sort')).toBe('name');
    // The controls reflect the URL, not just the query they sent.
    expect(screen.getByLabelText('Search')).toHaveProperty('value', 'headphones');
    expect(screen.getByLabelText('Category')).toHaveProperty('value', 'Audio');
    expect(screen.getByLabelText('Sort')).toHaveProperty('value', 'name');
  });

  it('debounces the search box: a run of keystrokes commits ONE navigation, after the pause', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { router } = await renderCatalogue('/', [
      productsRoute(() => jsonResponse(pageOf([productSummary()]))),
    ]);
    await vi.waitFor(() => expect(screen.queryByText('Sony WH-1000XM5')).not.toBeNull());

    const searchBox = screen.getByLabelText('Search');
    fireEvent.change(searchBox, { target: { value: 'h' } });
    fireEvent.change(searchBox, { target: { value: 'he' } });
    fireEvent.change(searchBox, { target: { value: 'hea' } });

    // Mid-keystroke: the URL has not moved yet — the debounce has not elapsed. `searchStr`, not
    // `search`: the latter is the router's PARSED search object, `searchStr` the raw query string
    // (`root-guards.test.tsx`'s own precedent).
    expect(router.state.location.searchStr).not.toContain('query=');

    await vi.advanceTimersByTimeAsync(400);

    expect(router.state.location.searchStr).toContain('query=hea');
  });
});
