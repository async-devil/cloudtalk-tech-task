import type { ModerationReviewSummary } from '@repo/contracts';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { apiQuery } from '../../shared/api/index.js';
import { toApiError } from '../../shared/errors/index.js';
import { queryKeys } from '../../shared/query-keys/index.js';

/** Matches `reviewsModerationListInputSchema`'s own default. */
const PAGE_SIZE = 20;

/** `@repo/contracts` exports `moderationStateSchema` as a runtime value (a Zod schema, for the
 * wire) but not its inferred type by name — derived here from the one review shape that already
 * carries it, `ADR-0004`'s "trust types inside" rather than re-declaring the two-value union by
 * hand a second time. */
export type ModerationState = ModerationReviewSummary['moderationState'];

/**
 * `reviews.moderationList` (SPEC-0001 S8): a paginated, newest-first list of reviews across every
 * product, scoped to one moderation `state` at a time — the same `useInfiniteQuery` convention
 * `product-detail`'s own `useProductReviews` establishes, and for the identical reason (a "Load
 * more" action appending the next cursor page, SPEC-0001's own wording repeated for S8).
 *
 * `state` is a HOOK PARAMETER, not internal state: `moderation-screen.tsx` owns the filter control
 * and re-renders this hook with a new `state` on every toggle, which is what makes switching
 * filters a normal query-key change (a fresh cache entry, `useInfiniteQuery`'s own reset-on-key-
 * change behaviour) rather than a manual refetch this hook would have to orchestrate itself.
 */
export function useModerationReviews(state: ModerationState) {
  const queryClient = useQueryClient();
  const query = useInfiniteQuery({
    ...apiQuery.reviews.moderationList.infiniteOptions({
      input: (cursor: string | undefined) => ({
        state,
        limit: PAGE_SIZE,
        ...(cursor !== undefined ? { cursor } : {}),
      }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }),
    retry: false,
  });

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const apiError = query.error === null ? undefined : toApiError(query.error);

  return {
    items,
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
    /**
     * Called after a successful reject/restore, scoped to THIS state filter only (SPEC-0001 S8:
     * "The row updates in place; no navigation") — see `moderation-screen.tsx`'s own doc on why
     * invalidating the current filter, rather than surgically patching the acted-on row in the
     * cache, is the simpler and equally correct choice: a rejected row dropping out of the
     * `published` list on refetch already IS the row updating in place from the moderator's own
     * point of view, and the `rejected` list they are not looking at needs no update yet — it will
     * read fresh the next time they switch to it, same as any other stale query.
     */
    invalidate: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.reviews.moderationList({ state }) }),
  };
}

export type ModerationReviewsQuery = ReturnType<typeof useModerationReviews>;
