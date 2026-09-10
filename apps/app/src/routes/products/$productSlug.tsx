import type { ReviewSummary } from '@repo/contracts';
import { ERROR_CODE } from '@repo/kernel';
import { Button, Card, CardContent } from '@repo/styles';
import { createFileRoute, type ErrorComponentProps, Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  ProductHeader,
  ProductHeaderSkeleton,
} from '../../features/product-detail/product-header.js';
import { ReviewCard } from '../../features/product-detail/review-card.js';
import { ReviewList } from '../../features/product-detail/review-list.js';
import {
  productDetailQueryOptions,
  useProductDetail,
} from '../../features/product-detail/use-product-detail.js';
import { useProductReviews } from '../../features/product-detail/use-product-reviews.js';
import { DeleteReviewDialog } from '../../features/review-submit/delete-review-dialog.js';
import { ReviewSubmitForm } from '../../features/review-submit/review-submit-form.js';
import { toApiError } from '../../shared/errors/index.js';
import { useSession } from '../../shared/session/index.js';

/**
 * S4's open state is a search param on THIS route (SPEC-0001: "not a separate route… its open
 * state is a search param so J3's round trip through sign-in returns to exactly it"). `.catch`,
 * the `sign-in.tsx`/`catalogue-search.ts` precedent: a malformed `review` value degrades to "form
 * closed", never a validation error over a URL the user did not type by hand.
 */
const productDetailSearchSchema = z.object({
  review: z.enum(['new', 'edit']).optional().catch(undefined),
});

export const Route = createFileRoute('/products/$productSlug')({
  validateSearch: productDetailSearchSchema,
  // Priming `products.get` in the LOADER (not `reviews.listForProduct`) is what lets S6's
  // `errorComponent` catch a `NOT_FOUND` before the screen renders at all. `reviews.listForProduct`
  // is deliberately NOT here — it is read by `useProductReviews` inside the component instead, so
  // ITS failure stays scoped to the list region ("list error while header succeeded", SPEC-0001 S3)
  // rather than failing the whole route.
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(productDetailQueryOptions(params.productSlug));
  },
  errorComponent: ProductDetailErrorComponent,
  component: ProductDetailRoute,
});

/**
 * S6, scoped to this route (SPEC-0001): a `NOT_FOUND` from the loader renders "This product
 * doesn't exist" with a link back to the catalogue. Any OTHER code is re-thrown during render —
 * caught by the nearest ANCESTOR `CatchBoundary` (root's, per `@tanstack/react-router`'s own
 * `Match.js`: `route.options.errorComponent ?? router.options.defaultErrorComponent` resolves per
 * route, and every route is wrapped in its own boundary, so a re-throw here is caught by root's),
 * which renders `router.tsx`'s `DefaultErrorComponent` — this app's ONE `observability.reportError`
 * call site. Calling it a second time from here would double-report the same failure, which is why
 * this component does not import `shared/observability` at all.
 */
function ProductDetailErrorComponent({ error }: ErrorComponentProps) {
  const apiError = toApiError(error);
  if (apiError.code !== ERROR_CODE.NotFound) {
    throw error;
  }
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <Card>
        <CardContent className="flex flex-col items-start gap-3">
          <p role="alert" data-testid="product-not-found">
            This product doesn't exist.
          </p>
          <Link to="/">Back to the catalogue</Link>
        </CardContent>
      </Card>
    </main>
  );
}

/**
 * A ROUTE MODULE composing TWO slices (`product-detail`, `review-submit`) — sanctioned by
 * TASK-0004's own scope line ("Routes compose them") and by dependency-cruiser's actual rule
 * (`fe-slice-isolation`: a FEATURE never imports another feature; a route importing two is a
 * different edge entirely). Each slice's own files are imported directly — there is no barrel, the
 * same shape `routes/sign-in.tsx` already uses for `features/sign-in/`.
 */
function ProductDetailRoute() {
  const { productSlug } = Route.useParams();
  const { review } = Route.useSearch();
  const navigate = Route.useNavigate();
  // Visitor surface (rule 15) — this only decides the form's submit-button-vs-sign-in-prompt
  // branch; nothing on this route is gated by it beyond that.
  const session = useSession();

  const productQuery = useProductDetail(productSlug);
  const reviewsQuery = useProductReviews(productSlug);
  const ownReview = reviewsQuery.ownReview;

  // "the new review is focused… needed for a screen reader to land on it" (SPEC-0001 S4's
  // after-success step). `pendingFocusToken` is set on success and cleared once the own-review
  // block actually shows that token — which also covers an EDIT (the token is unchanged, rule 6,
  // so the match is immediate) and a genuinely NEW review (the match lands once the invalidated
  // query re-fetches and the new row appears).
  const ownReviewRef = useRef<HTMLDivElement>(null);
  const [pendingFocusToken, setPendingFocusToken] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (pendingFocusToken !== undefined && ownReview?.token === pendingFocusToken) {
      ownReviewRef.current?.focus();
      setPendingFocusToken(undefined);
    }
  }, [pendingFocusToken, ownReview?.token]);

  function openForm(mode: 'new' | 'edit'): void {
    void navigate({ search: (prev) => ({ ...prev, review: mode }) });
  }

  function closeForm(): void {
    void navigate({ search: (prev) => ({ ...prev, review: undefined }) });
  }

  function handleRequestSignIn(): void {
    // Built directly rather than read off `window.location`: this is J3's OWN round trip, not the
    // generic 401 handler's (`shared/errors`' `installUnauthorizedRedirect`, which fires only once
    // a submit attempt actually 401s) — the sign-in PROMPT path never lets the request go out at
    // all, so there is no response to read a location from.
    void navigate({ to: '/sign-in', search: { returnTo: `/products/${productSlug}?review=new` } });
  }

  function handleFormSuccess(submittedReview: ReviewSummary): void {
    setPendingFocusToken(submittedReview.token);
    reviewsQuery.invalidate();
    closeForm();
  }

  function handleConflict(): void {
    // J6: a stale client submitted anyway. Refresh the list so the own-review block picks up what
    // the server already knows, then close the form on top of it.
    reviewsQuery.refetch();
    closeForm();
  }

  const isFormOpen = review === 'new' || review === 'edit';
  const productName = productQuery.data?.name ?? productSlug;

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      {productQuery.isLoading ? (
        <ProductHeaderSkeleton />
      ) : productQuery.data !== undefined ? (
        <ProductHeader product={productQuery.data} />
      ) : null}

      {isFormOpen ? (
        <ReviewSubmitForm
          productSlug={productSlug}
          productName={productName}
          mode={review === 'edit' ? 'edit' : 'new'}
          existingReview={review === 'edit' ? ownReview : undefined}
          isSignedIn={session !== undefined}
          onSuccess={handleFormSuccess}
          onCancel={closeForm}
          onConflict={handleConflict}
          onRequestSignIn={handleRequestSignIn}
        />
      ) : ownReview !== undefined ? (
        <section
          ref={ownReviewRef}
          tabIndex={-1}
          aria-label="Your review"
          className="flex flex-col gap-2 rounded-surface border border-border bg-surface-raised p-(--size-control-inset) outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus-ring)"
        >
          <ReviewCard review={ownReview} />
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => openForm('edit')}>
              Edit
            </Button>
            <DeleteReviewDialog
              productName={productName}
              review={ownReview}
              onDeleted={reviewsQuery.invalidate}
            />
          </div>
        </section>
      ) : (
        <Button type="button" onClick={() => openForm('new')} data-testid="write-a-review">
          Write a review
        </Button>
      )}

      <ReviewList query={reviewsQuery} />
    </main>
  );
}
