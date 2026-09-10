import { useQuery } from '@tanstack/react-query';
import { apiQuery } from '../../shared/api/index.js';

/**
 * `products.get`'s query options (SPEC-0001 S3): exported separately from the hook below so the
 * ROUTE's `loader` can `ensureQueryData` it — throwing a `NOT_FOUND`/other failure BEFORE the
 * component renders is what lets S6's route-level `errorComponent` catch it (TanStack Router
 * renders a route's `errorComponent` for a `loader` failure the same way it does for a thrown
 * render error).
 */
export function productDetailQueryOptions(productSlug: string) {
  return apiQuery.products.get.queryOptions({ input: { productSlug } });
}

/** The component-level read: after the loader has already primed the cache, this is a cache hit —
 * but the hook still works stand-alone (e.g. in a component test) without a loader in front of it. */
export function useProductDetail(productSlug: string) {
  return useQuery(productDetailQueryOptions(productSlug));
}
