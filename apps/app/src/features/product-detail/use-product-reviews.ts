import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { apiQuery } from '../../shared/api/index.js';
import { toApiError } from '../../shared/errors/index.js';
import { queryKeys } from '../../shared/query-keys/index.js';

/** Matches `reviewsListForProductInputSchema`'s own default. */
const PAGE_SIZE = 20;

/**
 * `reviews.listForProduct` (SPEC-0001 S3): the AUTHORITATIVE read, independent of
 * `use-product-detail.ts`'s `products.get` — "two queries, deliberately: one is the projection and
 * one is the truth (ADR-0014), and they invalidate on different events" (SPEC-0001's own words).
 * Independence is also what gives S3 its "list error while header succeeded" state for free: this
 * hook's `isError` never touches the header's query.
 *
 * `useInfiniteQuery`, the same choice `catalogue`'s own list hook documents and for the same
 * reason.
 */
export function useProductReviews(productSlug: string) {
  const queryClient = useQueryClient();
  const query = useInfiniteQuery({
    ...apiQuery.reviews.listForProduct.infiniteOptions({
      input: (cursor: string | undefined) => ({
        productSlug,
        limit: PAGE_SIZE,
        ...(cursor !== undefined ? { cursor } : {}),
      }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }),
    retry: false,
  });

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  // At most one row carries `authoredByViewer: true` (SPEC-0003's own doc on the field, mirroring
  // SPEC-0001 rule 2 — one review per author per product). Scoped to whichever pages are LOADED:
  // there is no dedicated "my review" endpoint, so an own review sitting past the currently loaded
  // pages will not surface here until a "Load more" reaches it — a known, accepted limit of reusing
  // this list rather than a second round trip (see the report for this task).
  const ownReview = items.find((review) => review.authoredByViewer);
  const apiError = query.error === null ? undefined : toApiError(query.error);

  return {
    items,
    ownReview,
    isLoading: query.isLoading,
    isError: query.isError,
    apiError,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: () => {
      void query.fetchNextPage();
    },
    refetch: () => {
      void query.refetch();
    },
    /** Called by `review-submit` (through the route, never a direct slice import) after a
     * successful submit/edit/delete — SPEC-0001 S4's "the review list is invalidated and
     * refetched". Deliberately NOT touching `products.get`'s cache: ADR-0014/TASK-0004's own note,
     * "the UI should not paper over [staleness] with an optimistic average". */
    invalidate: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.reviews.listForProduct(productSlug) }),
  };
}

export type ProductReviewsQuery = ReturnType<typeof useProductReviews>;
