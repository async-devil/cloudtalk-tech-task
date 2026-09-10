import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppRouter } from '../src/router.js';
import { setErrorSink } from '../src/shared/observability/index.js';
import {
  type ApiRoute,
  bootstrapPayload,
  type FetchStub,
  jsonResponse,
  pageOf,
  productDetail,
  reviewSummary,
  stubApiFetch,
  unauthorizedResponse,
  wireError,
} from './harness/api-responses.js';

/**
 * S3/S4/S5/S6 — product detail, the review form, delete confirmation, and the not-found/error
 * extension (SPEC-0001), driven through a REAL router navigation to `/products/$productSlug` (the
 * same shape `catalogue-screen.test.tsx` and `router-error-boundary.test.tsx` use).
 */

let stub: FetchStub | undefined;
let restoreSink: (() => void) | undefined;

afterEach(() => {
  stub?.restore();
  stub = undefined;
  restoreSink?.();
  restoreSink = undefined;
  cleanup();
  sessionStorage.clear();
});

function sessionRoute(
  signedIn: boolean,
  overrides: Parameters<typeof bootstrapPayload>[0] = {},
): ApiRoute {
  return {
    method: 'GET',
    test: (url) => url.pathname === '/api/session/bootstrap',
    respond: () => (signedIn ? jsonResponse(bootstrapPayload(overrides)) : unauthorizedResponse()),
  };
}

function productGetRoute(respond: ApiRoute['respond']): ApiRoute {
  return { method: 'GET', test: (url) => /^\/api\/products\/[^/]+$/.test(url.pathname), respond };
}

function reviewsListRoute(respond: ApiRoute['respond']): ApiRoute {
  return {
    method: 'GET',
    test: (url) => /^\/api\/products\/[^/]+\/reviews$/.test(url.pathname),
    respond,
  };
}

function reviewSubmitRoute(respond: ApiRoute['respond']): ApiRoute {
  return {
    method: 'POST',
    test: (url) => /^\/api\/products\/[^/]+\/reviews$/.test(url.pathname),
    respond,
  };
}

function reviewUpdateRoute(respond: ApiRoute['respond']): ApiRoute {
  return { method: 'PATCH', test: (url) => /^\/api\/reviews\/[^/]+$/.test(url.pathname), respond };
}

function reviewRemoveRoute(respond: ApiRoute['respond']): ApiRoute {
  return { method: 'DELETE', test: (url) => /^\/api\/reviews\/[^/]+$/.test(url.pathname), respond };
}

async function renderProductDetail(
  initialPath: string,
  routes: readonly ApiRoute[],
  options: { readonly signedIn?: boolean; readonly canManageCatalogue?: boolean } = {},
) {
  stub = stubApiFetch([
    sessionRoute(options.signedIn ?? false, {
      canManageCatalogue: options.canManageCatalogue ?? false,
    }),
    ...routes,
  ]);
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

describe('S3 — product header and reviews (independent loading/error)', () => {
  it('renders the header: name, category, price, SKU, description, and the aggregate spelled out', async () => {
    await renderProductDetail('/products/sony-wh-1000xm5', [
      productGetRoute(() => jsonResponse(productDetail())),
      reviewsListRoute(() => jsonResponse(pageOf([]))),
    ]);

    await screen.findByRole('heading', { name: 'Sony WH-1000XM5' });
    expect(screen.getByText('Audio')).toBeTruthy();
    expect(screen.getByText('SKU AUD-WH1000XM5')).toBeTruthy();
    expect(screen.getByText(/349\.99/)).toBeTruthy();
    expect(screen.getByText('Noise-cancelling over-ear headphones.')).toBeTruthy();
    expect(screen.getByText(/Average from 12 reviews, calculated/)).toBeTruthy();
  });

  it('"No reviews yet" for an unrated product — never 0 or 0.0 (rule 14)', async () => {
    await renderProductDetail('/products/sony-wh-1000xm5', [
      productGetRoute(() =>
        jsonResponse(
          productDetail({ rating: { reviewCount: 0, ratingAverage: null, computedAt: null } }),
        ),
      ),
      reviewsListRoute(() => jsonResponse(pageOf([]))),
    ]);

    await screen.findByText('No reviews yet');
  });

  it('no reviews at all: "Be the first to review this product" alongside the submit action', async () => {
    await renderProductDetail('/products/sony-wh-1000xm5', [
      productGetRoute(() => jsonResponse(productDetail())),
      reviewsListRoute(() => jsonResponse(pageOf([]))),
    ]);

    await screen.findByText('Be the first to review this product.');
    expect(screen.getByTestId('write-a-review')).toBeTruthy();
  });

  it('list error while header succeeded: the list region alone shows the error, the header stays', async () => {
    await renderProductDetail('/products/sony-wh-1000xm5', [
      productGetRoute(() => jsonResponse(productDetail())),
      reviewsListRoute(() => wireError('INTERNAL', 'boom', 500)),
    ]);

    await screen.findByRole('heading', { name: 'Sony WH-1000XM5' });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Something went wrong. Please try again.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('renders reviews newest-first with rating, title, body, author, date, and an "edited" marker', async () => {
    await renderProductDetail('/products/sony-wh-1000xm5', [
      productGetRoute(() => jsonResponse(productDetail())),
      reviewsListRoute(() =>
        jsonResponse(
          pageOf([
            reviewSummary({
              token: 'rev_editedreview00000001',
              title: 'Edited later',
              updatedAt: '2026-09-05T00:00:00.000Z',
            }),
          ]),
        ),
      ),
    ]);

    await screen.findByText('Edited later');
    expect(screen.getByText(/edited/)).toBeTruthy();
    expect(screen.getByText(/jane/)).toBeTruthy();
  });
});

describe('S3 — the "Edit product" entry point (TASK-0008)', () => {
  it('is absent for an anonymous visitor', async () => {
    await renderProductDetail('/products/sony-wh-1000xm5', [
      productGetRoute(() => jsonResponse(productDetail())),
      reviewsListRoute(() => jsonResponse(pageOf([]))),
    ]);

    await screen.findByRole('heading', { name: 'Sony WH-1000XM5' });
    expect(screen.queryByTestId('edit-product-link')).toBeNull();
  });

  it('is absent for a signed-in session without canManageCatalogue', async () => {
    await renderProductDetail(
      '/products/sony-wh-1000xm5',
      [
        productGetRoute(() => jsonResponse(productDetail())),
        reviewsListRoute(() => jsonResponse(pageOf([]))),
      ],
      { signedIn: true, canManageCatalogue: false },
    );

    await screen.findByRole('heading', { name: 'Sony WH-1000XM5' });
    expect(screen.queryByTestId('edit-product-link')).toBeNull();
  });

  it('is present for a catalogue manager, linking to the edit route', async () => {
    await renderProductDetail(
      '/products/sony-wh-1000xm5',
      [
        productGetRoute(() => jsonResponse(productDetail())),
        reviewsListRoute(() => jsonResponse(pageOf([]))),
      ],
      { signedIn: true, canManageCatalogue: true },
    );

    await screen.findByRole('heading', { name: 'Sony WH-1000XM5' });
    // `findByTestId`, not `getByTestId`: `/products/$productSlug` is Visitor surface (in
    // `PUBLIC_ROUTES`), so the ROOT guard never primes the session bootstrap query — only this
    // component's own `useSession()` call triggers it, and it may still be in flight once the
    // (separately-queried) product header has already rendered.
    const link = await screen.findByTestId('edit-product-link');
    expect(link.getAttribute('href')).toBe('/products/sony-wh-1000xm5/edit');
  });
});

describe('S6 — not-found and the shared error boundary', () => {
  it('NOT_FOUND renders "This product doesn\'t exist" with a link back to the catalogue', async () => {
    await renderProductDetail('/products/does-not-exist', [
      productGetRoute(() => wireError('NOT_FOUND', 'no such product', 404)),
    ]);

    const message = await screen.findByTestId('product-not-found');
    expect(message.textContent).toBe("This product doesn't exist.");
    const link = screen.getByRole('link', { name: 'Back to the catalogue' });
    expect(link.getAttribute('href')).toBe('/');
  });

  it("any OTHER code re-throws to the router's ONE shared error boundary and IS reported", async () => {
    const sink = vi.fn();
    restoreSink = setErrorSink(sink);

    await renderProductDetail('/products/sony-wh-1000xm5', [
      productGetRoute(() => wireError('INTERNAL', 'boom', 500)),
    ]);

    const alert = await screen.findByTestId('route-error');
    expect(alert.textContent).toBe('Something went wrong. Please try again.');
    // Not S6's own copy — this went to the SHARED boundary, not this route's 404 branch.
    expect(screen.queryByTestId('product-not-found')).toBeNull();
    // NOT an exact call-COUNT assertion (unlike `router-error-boundary.test.tsx`'s plain case):
    // React's development build deliberately re-attempts rendering a component that throws
    // DURING RENDER before finalizing the boundary fallback (verified by hand here — this route's
    // `errorComponent` re-throwing synchronously is exactly that shape, unlike a loader failure
    // with no nested boundary in between), so `DefaultErrorComponent` genuinely mounts twice for
    // this specific path. What this test asserts is the thing that actually matters: the failure
    // reaches the ONE reporting call site at all, with the right code — not a second, LOCAL
    // `observability.reportError` call added to this route (which is what this route's own doc
    // comment promises it never does).
    await waitFor(() => expect(sink).toHaveBeenCalled());
    const [reportedError, context] = sink.mock.calls.at(0) ?? [];
    expect((reportedError as Error).name).toBe('ApiError');
    expect(context).toMatchObject({ boundary: 'router', code: 'INTERNAL' });
  });
});

describe('S3 own-review block + S4 the review form', () => {
  it('signed out: "Write a review" opens the form with a sign-in prompt in place of the submit button', async () => {
    await renderProductDetail(
      '/products/sony-wh-1000xm5',
      [
        productGetRoute(() => jsonResponse(productDetail())),
        reviewsListRoute(() => jsonResponse(pageOf([]))),
      ],
      { signedIn: false },
    );

    await screen.findByText('Be the first to review this product.');
    fireEvent.click(screen.getByTestId('write-a-review'));

    await screen.findByRole('heading', { name: 'Write a review' });
    expect(screen.queryByTestId('review-submit')).toBeNull();
    const signInPrompt = screen.getByTestId('review-sign-in-prompt');
    expect(signInPrompt.textContent).toBe('Sign in to submit your review');

    fireEvent.click(signInPrompt);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy();
    });
  });

  it('J3: the draft is written to sessionStorage as the visitor types, product-scoped', async () => {
    await renderProductDetail(
      '/products/sony-wh-1000xm5',
      [
        productGetRoute(() => jsonResponse(productDetail())),
        reviewsListRoute(() => jsonResponse(pageOf([]))),
      ],
      { signedIn: false },
    );

    fireEvent.click(await screen.findByTestId('write-a-review'));
    await screen.findByRole('heading', { name: 'Write a review' });

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'My draft title' } });

    await waitFor(() => {
      const raw = sessionStorage.getItem('review-draft:sony-wh-1000xm5');
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw as string).title).toBe('My draft title');
    });
  });

  it('signed in: submitting a valid review closes the form, invalidates the list, and focuses the own-review block', async () => {
    let sawSubmitBody: unknown;
    // Stateful, like the real api: the list is empty until the submission actually lands, and the
    // invalidated refetch afterwards is what has to pick the new review up — a static mock here
    // would prove the request went out without proving the SPEC-0001 S4 "invalidated and
    // refetched" step actually surfaces the result.
    const submittedReview = reviewSummary({
      token: 'rev_newlysubmitted000001',
      rating: 5,
      title: 'Fantastic purchase',
      body: 'Exactly what I wanted, would buy again.',
      authoredByViewer: true,
    });
    let reviewsOnServer: ReturnType<typeof reviewSummary>[] = [];

    const { router } = await renderProductDetail(
      '/products/sony-wh-1000xm5?review=new',
      [
        productGetRoute(() => jsonResponse(productDetail())),
        reviewsListRoute(() => jsonResponse(pageOf(reviewsOnServer))),
        reviewSubmitRoute(async (request) => {
          sawSubmitBody = await request.json();
          reviewsOnServer = [submittedReview, ...reviewsOnServer];
          return jsonResponse(submittedReview);
        }),
      ],
      { signedIn: true },
    );

    await screen.findByRole('heading', { name: 'Write a review' });

    fireEvent.click(screen.getByRole('radio', { name: '5 stars' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Fantastic purchase' } });
    fireEvent.change(screen.getByLabelText('Review'), {
      target: { value: 'Exactly what I wanted, would buy again.' },
    });
    // `findByTestId`, not `getByTestId`: `isSignedIn` comes from `useSession()`, which resolves
    // asynchronously even for a signed-in visitor (the bootstrap query only starts fetching once
    // this PUBLIC route's component mounts — see `unauthorized-redirect.ts`'s own note on why the
    // route itself no longer pre-fetches it) — the submit button is not there on the very first
    // render.
    fireEvent.click(await screen.findByTestId('review-submit'));

    await waitFor(() =>
      expect(sawSubmitBody).toMatchObject({ rating: 5, title: 'Fantastic purchase' }),
    );

    // The form closed — the `review` search param dropped.
    await waitFor(() => expect(router.state.location.searchStr).not.toContain('review='));
    await screen.findByText('Fantastic purchase');

    // The draft is gone.
    expect(sessionStorage.getItem('review-draft:sony-wh-1000xm5')).toBeNull();

    // Focused for a screen reader to land on it (SPEC-0001 S4's after-success step).
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Your review');
    });
  });

  it("VALIDATION with details.field attaches the server's answer to that field — the draft survives", async () => {
    await renderProductDetail(
      '/products/sony-wh-1000xm5?review=new',
      [
        productGetRoute(() => jsonResponse(productDetail())),
        reviewsListRoute(() => jsonResponse(pageOf([]))),
        reviewSubmitRoute(() =>
          jsonResponse(
            { code: 'VALIDATION', message: 'invalid', details: { field: 'title' } },
            400,
          ),
        ),
      ],
      { signedIn: true },
    );

    await screen.findByRole('heading', { name: 'Write a review' });
    fireEvent.click(screen.getByRole('radio', { name: '4 stars' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A fine title' } });
    fireEvent.change(screen.getByLabelText('Review'), {
      target: { value: 'A perfectly reasonable review body here.' },
    });
    // `findByTestId`, not `getByTestId`: `isSignedIn` comes from `useSession()`, which resolves
    // asynchronously even for a signed-in visitor (the bootstrap query only starts fetching once
    // this PUBLIC route's component mounts — see `unauthorized-redirect.ts`'s own note on why the
    // route itself no longer pre-fetches it) — the submit button is not there on the very first
    // render.
    fireEvent.click(await screen.findByTestId('review-submit'));

    const fieldError = await screen.findByText('Please check what you entered and try again.');
    // Attached to the title field specifically, not a bare form-level banner.
    expect(fieldError.id).not.toBe('');
    expect(screen.queryByTestId('review-form-error')).toBeNull();
    // Nothing destroyed by the failure.
    expect(screen.getByLabelText('Title')).toHaveProperty('value', 'A fine title');
  });

  it('CONFLICT (J6): "already reviewed" copy with a "View your review" action', async () => {
    await renderProductDetail(
      '/products/sony-wh-1000xm5?review=new',
      [
        productGetRoute(() => jsonResponse(productDetail())),
        reviewsListRoute(() => jsonResponse(pageOf([]))),
        reviewSubmitRoute(() => wireError('CONFLICT', 'already reviewed', 409)),
      ],
      { signedIn: true },
    );

    await screen.findByRole('heading', { name: 'Write a review' });
    fireEvent.click(screen.getByRole('radio', { name: '3 stars' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Second attempt' } });
    fireEvent.change(screen.getByLabelText('Review'), {
      target: { value: 'Trying to submit a second review for this product.' },
    });
    // `findByTestId`, not `getByTestId`: `isSignedIn` comes from `useSession()`, which resolves
    // asynchronously even for a signed-in visitor (the bootstrap query only starts fetching once
    // this PUBLIC route's component mounts — see `unauthorized-redirect.ts`'s own note on why the
    // route itself no longer pre-fetches it) — the submit button is not there on the very first
    // render.
    fireEvent.click(await screen.findByTestId('review-submit'));

    const error = await screen.findByTestId('review-form-error');
    expect(error.textContent).toBe('That has already changed. Reload and try again.');
    expect(screen.getByRole('button', { name: 'View your review' })).toBeTruthy();
  });

  it('RATE_LIMITED says to wait, without destroying the draft', async () => {
    await renderProductDetail(
      '/products/sony-wh-1000xm5?review=new',
      [
        productGetRoute(() => jsonResponse(productDetail())),
        reviewsListRoute(() => jsonResponse(pageOf([]))),
        reviewSubmitRoute(() => wireError('RATE_LIMITED', 'slow down', 429)),
      ],
      { signedIn: true },
    );

    await screen.findByRole('heading', { name: 'Write a review' });
    fireEvent.click(screen.getByRole('radio', { name: '2 stars' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Rate limited attempt' } });
    fireEvent.change(screen.getByLabelText('Review'), {
      target: { value: 'This one should get rate limited by the stub.' },
    });
    // `findByTestId`, not `getByTestId`: `isSignedIn` comes from `useSession()`, which resolves
    // asynchronously even for a signed-in visitor (the bootstrap query only starts fetching once
    // this PUBLIC route's component mounts — see `unauthorized-redirect.ts`'s own note on why the
    // route itself no longer pre-fetches it) — the submit button is not there on the very first
    // render.
    fireEvent.click(await screen.findByTestId('review-submit'));

    const error = await screen.findByTestId('review-form-error');
    expect(error.textContent).toBe('Too many requests. Please wait a moment and try again.');
    expect(screen.getByLabelText('Title')).toHaveProperty('value', 'Rate limited attempt');
  });

  it('the own-review block replaces the submit prompt and offers Edit + Delete', async () => {
    await renderProductDetail(
      '/products/sony-wh-1000xm5',
      [
        productGetRoute(() => jsonResponse(productDetail())),
        reviewsListRoute(() =>
          jsonResponse(
            pageOf([
              reviewSummary({
                token: 'rev_ownreview0000000001',
                authoredByViewer: true,
                title: 'My own take',
              }),
              reviewSummary({
                token: 'rev_someoneelse00000001',
                authoredByViewer: false,
                title: 'A stranger review',
              }),
            ]),
          ),
        ),
      ],
      { signedIn: true },
    );

    await screen.findByText('My own take');
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(screen.queryByTestId('write-a-review')).toBeNull();

    // The general list shows the OTHER review but not the viewer's own (pulled out above it).
    await screen.findByText('A stranger review');
    const ownReviewSection = screen.getByLabelText('Your review');
    expect(ownReviewSection.textContent).toContain('My own take');
    expect(ownReviewSection.textContent).not.toContain('A stranger review');
  });

  it('J4: Edit re-uses the submission form pre-filled, and saves through reviews.update (PATCH)', async () => {
    let sawUpdateBody: unknown;
    let sawUpdateUrl: string | undefined;
    let currentReview = reviewSummary({
      token: 'rev_ownreview0000000001',
      authoredByViewer: true,
      rating: 3,
      title: 'Original title',
      body: 'The original review body, written a while ago.',
    });

    await renderProductDetail(
      '/products/sony-wh-1000xm5',
      [
        productGetRoute(() => jsonResponse(productDetail())),
        // Stateful — same reasoning as the submit-success and delete tests: the refetch after
        // invalidation has to see the UPDATED row for this test to prove the round trip, not just
        // that a PATCH went out.
        reviewsListRoute(() => jsonResponse(pageOf([currentReview]))),
        reviewUpdateRoute(async (request) => {
          sawUpdateBody = await request.json();
          sawUpdateUrl = request.url;
          currentReview = {
            ...currentReview,
            title: 'Updated title',
            updatedAt: '2026-09-08T00:00:00.000Z',
          };
          return jsonResponse(currentReview);
        }),
      ],
      { signedIn: true },
    );

    await screen.findByText('Original title');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    // Pre-filled from the existing review, not blank.
    await screen.findByRole('heading', { name: 'Edit your review' });
    expect(screen.getByLabelText('Title')).toHaveProperty('value', 'Original title');
    expect(screen.getByLabelText('Review')).toHaveProperty(
      'value',
      'The original review body, written a while ago.',
    );

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Updated title' } });
    fireEvent.click(await screen.findByTestId('review-submit'));

    await waitFor(() => {
      // `reviewToken` is a PATH param on this route (`/reviews/{reviewToken}`), never part of the
      // body — asserted on the URL, not `sawUpdateBody`.
      expect(sawUpdateUrl).toContain('/reviews/rev_ownreview0000000001');
      expect(sawUpdateBody).toMatchObject({ title: 'Updated title' });
    });
    await screen.findByText('Updated title');
  });
});

describe('S5 — delete confirmation', () => {
  /**
   * Stateful, like the real api (the same reasoning the S4 submit-success test documents): the
   * review-list route keeps serving the own review until a SUCCESSFUL delete removes it, so a test
   * asserting "the own review is gone after confirming" is asserting the real invalidate-and-
   * refetch round trip, not a mock that was always going to say so.
   */
  function renderWithOwnReview(deleteRespond: ApiRoute['respond']) {
    let reviewExists = true;
    return renderProductDetail(
      '/products/sony-wh-1000xm5',
      [
        productGetRoute(() => jsonResponse(productDetail())),
        reviewsListRoute(() =>
          jsonResponse(
            pageOf(
              reviewExists
                ? [
                    reviewSummary({
                      token: 'rev_ownreview0000000001',
                      authoredByViewer: true,
                      rating: 4,
                      title: 'My own take',
                    }),
                  ]
                : [],
            ),
          ),
        ),
        reviewRemoveRoute(async (request) => {
          const response = await deleteRespond(request);
          if (response.ok) {
            reviewExists = false;
          }
          return response;
        }),
      ],
      { signedIn: true },
    );
  }

  it('names the product and the rating being removed, and confirm is destructive-styled', async () => {
    await renderWithOwnReview(() => Response.json({ token: 'rev_ownreview0000000001' }));

    await screen.findByText('My own take');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog', { name: 'Delete this review?' });
    expect(dialog.textContent).toContain('This removes your 4-star rating of Sony WH-1000XM5.');
    const confirmButton = screen.getByRole('button', { name: 'Delete' });
    expect(confirmButton.className).toContain('bg-danger');
  });

  it('Cancel closes the dialog without deleting anything', async () => {
    const removeCalls: unknown[] = [];
    await renderWithOwnReview((request) => {
      removeCalls.push(request);
      return Response.json({ token: 'rev_ownreview0000000001' });
    });

    await screen.findByText('My own take');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(removeCalls).toHaveLength(0);
    expect(screen.getByText('My own take')).toBeTruthy();
  });

  it('disables BOTH actions while the delete is in flight, and removes the own review on success', async () => {
    let resolveDelete: (() => void) | undefined;
    await renderWithOwnReview(
      () =>
        new Promise<Response>((resolve) => {
          resolveDelete = () => resolve(Response.json({ token: 'rev_ownreview0000000001' }));
        }),
    );

    await screen.findByText('My own take');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      // `.disabled` directly: `@testing-library/jest-dom`'s `toBeDisabled` matcher is not
      // registered in this suite's vitest setup (no other test in this repo uses it either).
      expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      expect(
        (screen.getByRole('button', { name: 'Deleting…' }) as HTMLButtonElement).disabled,
      ).toBe(true);
    });

    resolveDelete?.();

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.queryByText('My own take')).toBeNull());
    await screen.findByTestId('write-a-review');
  });
});
