import { ERROR_CODE } from '@repo/kernel';
import { Button, Card, CardContent } from '@repo/styles';
import { errorMessageFor } from '../../shared/errors/index.js';
import { ReviewCard } from './review-card.js';
import type { ProductReviewsQuery } from './use-product-reviews.js';

export interface ReviewListProps {
  readonly query: ProductReviewsQuery;
}

const SKELETON_COUNT = 3;

/**
 * The review list (SPEC-0001 S3): newest first, cursor-paginated with "Load more", scoped to its
 * OWN query's loading/error state — the header renders from a DIFFERENT query
 * (`use-product-detail.ts`) and must stay up when only this one fails ("list error while header
 * succeeded").
 */
export function ReviewList({ query }: ReviewListProps) {
  // The viewer's own review is pulled out and shown separately, above this list (SPEC-0001 S3's
  // own-review block) — never duplicated inside it.
  const items = query.items.filter((review) => !review.authoredByViewer);

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        {Array.from({ length: SKELETON_COUNT }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-count skeleton row has no identity of its own to key by.
          <div key={index} className="h-20 animate-pulse rounded-control bg-surface-sunken" />
        ))}
      </div>
    );
  }

  if (query.isError) {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-3">
          <p role="alert">{errorMessageFor(query.apiError?.code ?? ERROR_CODE.Internal)}</p>
          <Button type="button" onClick={query.refetch}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (items.length === 0) {
    // The "no reviews at all" copy only applies when there is truly nothing — including no own
    // review shown above (the route's own composition decides whether the "Write a review" action
    // accompanies this, per SPEC-0001 S3: "no reviews — 'Be the first to review this product' with
    // the submit action").
    if (query.ownReview === undefined) {
      return <p>Be the first to review this product.</p>;
    }
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col">
        {items.map((review) => (
          <ReviewCard key={review.token} review={review} />
        ))}
      </ul>
      {query.hasNextPage && (
        <Button
          type="button"
          variant="outline"
          onClick={query.fetchNextPage}
          disabled={query.isFetchingNextPage}
        >
          {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  );
}
