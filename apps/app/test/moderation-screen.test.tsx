/**
 * S8 — the moderation screen (SPEC-0001, TASK-0009), driven through a REAL router navigation to
 * `/moderation` — the same shape `catalogue-screen.test.tsx`/`product-detail-route.test.tsx`
 * already use. A session with `canModerate: true` is required to reach it at all
 * (`moderation-guards.test.tsx` covers the redirect for everyone else), so every test here signs
 * one in.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppRouter } from '../src/router.js';
import {
  type ApiRoute,
  bootstrapPayload,
  type FetchStub,
  jsonResponse,
  moderationReviewSummary,
  pageOf,
  reviewSummary,
  stubApiFetch,
  wireError,
} from './harness/api-responses.js';

let stub: FetchStub | undefined;

afterEach(() => {
  stub?.restore();
  stub = undefined;
  cleanup();
});

function sessionRoute(): ApiRoute {
  return {
    method: 'GET',
    test: (url) => url.pathname === '/api/session/bootstrap',
    respond: () => jsonResponse(bootstrapPayload({ canModerate: true })),
  };
}

async function renderModeration(extraRoutes: readonly ApiRoute[]) {
  stub = stubApiFetch([sessionRoute(), ...extraRoutes]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: ['/moderation'] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { queryClient, router };
}

function moderationListRoute(respond: ApiRoute['respond']): ApiRoute {
  return { method: 'GET', test: (url) => url.pathname === '/api/moderation/reviews', respond };
}

describe('ModerationScreen — loading, list, empty and error states', () => {
  it('renders row skeletons while the list is in flight', async () => {
    await renderModeration([
      moderationListRoute(
        () =>
          new Promise<Response>(() => {
            // Deliberately never settles — asserts only the loading frame.
          }),
      ),
    ]);

    await screen.findByRole('heading', { name: 'Moderation' });
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('renders a row: product name/link, rating, title, body, author, date and state', async () => {
    await renderModeration([
      moderationListRoute(() => jsonResponse(pageOf([moderationReviewSummary()]))),
    ]);

    const link = await screen.findByRole('link', { name: 'Sony WH-1000XM5' });
    expect(link.getAttribute('href')).toBe('/products/sony-wh-1000xm5');
    expect(screen.getByText('Great headphones')).toBeTruthy();
    expect(
      screen.getByText('Really happy with the noise cancelling and the battery life on these.'),
    ).toBeTruthy();
    expect(screen.getByText('published')).toBeTruthy();
    expect(screen.getByText(/jane/)).toBeTruthy();

    // SPEC-0001 S8's own example shape, composed from the row's OWN authorLabel/productName —
    // never a bare "Reject" repeated down the list.
    expect(
      screen.getByRole('button', { name: 'Reject review by jane on Sony WH-1000XM5' }),
    ).toBeTruthy();
  });

  it('empty: "No reviews yet"', async () => {
    await renderModeration([moderationListRoute(() => jsonResponse(pageOf([])))]);
    await screen.findByText('No reviews yet.');
  });

  it('error: the message-map copy for the code, scoped to the list, with a retry action', async () => {
    await renderModeration([moderationListRoute(() => wireError('INTERNAL', 'boom', 500))]);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Something went wrong. Please try again.');
    expect(alert.textContent).not.toContain('boom');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});

describe('ModerationScreen — reject/restore, no confirmation, no navigation', () => {
  it('rejecting a published row removes it from the (still `published`) filtered list', async () => {
    let moderationState: 'published' | 'rejected' = 'published';
    const { router } = await renderModeration([
      moderationListRoute((request) => {
        const requestedState = new URL(request.url).searchParams.get('state') ?? 'published';
        const items =
          requestedState === moderationState ? [moderationReviewSummary({ moderationState })] : [];
        return jsonResponse(pageOf(items));
      }),
      {
        method: 'POST',
        test: (url) => url.pathname === '/api/reviews/rev_AAAAAAAAAAAAAAAAAAAAA/reject',
        respond: () => {
          moderationState = 'rejected';
          return jsonResponse(reviewSummary());
        },
      },
    ]);

    const rejectButton = await screen.findByRole('button', {
      name: 'Reject review by jane on Sony WH-1000XM5',
    });
    fireEvent.click(rejectButton);

    // No confirmation dialog anywhere in this flow (SPEC-0001 S8: reversible, so it needs none) —
    // the click above is the WHOLE interaction. The row drops out once the reject succeeds and the
    // `published` filter re-fetches; no navigation happens either (the router stays on `/moderation`).
    await screen.findByText('No reviews yet.');
    expect(router.state.location.pathname).toBe('/moderation');
  });

  it('restoring a rejected row removes it from the (still `rejected`) filtered list', async () => {
    let moderationState: 'published' | 'rejected' = 'rejected';
    await renderModeration([
      moderationListRoute((request) => {
        const requestedState = new URL(request.url).searchParams.get('state') ?? 'published';
        const items =
          requestedState === moderationState ? [moderationReviewSummary({ moderationState })] : [];
        return jsonResponse(pageOf(items));
      }),
      {
        method: 'POST',
        test: (url) => url.pathname === '/api/reviews/rev_AAAAAAAAAAAAAAAAAAAAA/restore',
        respond: () => {
          moderationState = 'published';
          return jsonResponse(reviewSummary());
        },
      },
    ]);

    // Defaults to `published` (SPEC-0001 S8) — switch to `rejected` to see the seeded row.
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'rejected' } });

    const restoreButton = await screen.findByRole('button', {
      name: 'Restore review by jane on Sony WH-1000XM5',
    });
    fireEvent.click(restoreButton);

    await screen.findByText('No reviews yet.');
  });

  it("a failed reject shows a row-scoped error and leaves the OTHER row's action untouched", async () => {
    await renderModeration([
      moderationListRoute(() =>
        jsonResponse(
          pageOf([
            moderationReviewSummary({
              token: 'rev_AAAAAAAAAAAAAAAAAAAAA',
              authorLabel: 'alice',
            }),
            moderationReviewSummary({
              token: 'rev_BBBBBBBBBBBBBBBBBBBBB',
              authorLabel: 'bob',
              productSlug: 'other-product',
              productName: 'Other Product',
            }),
          ]),
        ),
      ),
      {
        method: 'POST',
        test: (url) => url.pathname === '/api/reviews/rev_AAAAAAAAAAAAAAAAAAAAA/reject',
        respond: () => wireError('INTERNAL', 'boom', 500),
      },
    ]);

    const rejectButton = await screen.findByRole('button', {
      name: 'Reject review by alice on Sony WH-1000XM5',
    });
    fireEvent.click(rejectButton);

    await waitFor(() => {
      expect(screen.getByText('Something went wrong. Please try again.')).toBeTruthy();
    });
    // The OTHER row's action is still present and enabled — a per-row failure never disables the
    // rest of the list.
    const otherReject = screen.getByRole('button', {
      name: 'Reject review by bob on Other Product',
    });
    expect((otherReject as HTMLButtonElement).disabled).toBe(false);
  });
});
