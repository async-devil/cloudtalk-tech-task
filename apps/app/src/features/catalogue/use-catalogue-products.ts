import { useInfiniteQuery } from '@tanstack/react-query';
import { apiQuery } from '../../shared/api/index.js';
import { toApiError } from '../../shared/errors/index.js';
import type { CatalogueFilters } from './catalogue-search.js';

/** SPEC-0001 gives no page size; 20 matches `productsListInputSchema`'s own default so the first
 * page this hook asks for is identical to what an unparameterized request would already return. */
const PAGE_SIZE = 20;

/**
 * The catalogue's list query (SPEC-0001 S2), one `useInfiniteQuery` per active filter set.
 *
 * `useInfiniteQuery` OVER hand-rolled cursor state (a documented choice, per TASK-0004's own
 * invitation to pick one): TanStack Query already owns "accumulate pages, dedupe a concurrent
 * refetch, expose `hasNextPage`/`isFetchingNextPage`" — re-deriving that with a `useState<string[]>`
 * accumulator would duplicate logic this dependency already ships and already tests. The cost named
 * where it is paid: the accumulated pages live in the QUERY CACHE, keyed by the filter set, not in
 * the URL's `cursor` param — reloading a deep link replays page ONE of a filter, never "wherever
 * Load More had gotten to". SPEC-0001's own S2 prose for pagination ("a Load more action appending
 * the next cursor page… takes the keyboard focus away from nobody and needs no scroll restoration")
 * never asks for a resumable position on reload — only the FILTER is specified as URL state — so
 * this reads as the intended scope, not a shortcut past it.
 */
export function useCatalogueProducts(filters: CatalogueFilters) {
  const query = useInfiniteQuery({
    ...apiQuery.products.list.infiniteOptions({
      input: (cursor: string | undefined) => ({
        ...(filters.query !== undefined ? { query: filters.query } : {}),
        ...(filters.category !== undefined ? { category: filters.category } : {}),
        sort: filters.sort,
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
  };
}

export type CatalogueProductsQuery = ReturnType<typeof useCatalogueProducts>;
