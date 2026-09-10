import type { ModerationReviewSummary } from '@repo/contracts';
import { Button, Card, CardContent, FieldError, Spinner } from '@repo/styles';
import { Link } from '@tanstack/react-router';
import type { ApiError } from '../../shared/errors/index.js';
import { errorMessageFor } from '../../shared/errors/index.js';
import { RatingStarsDisplay } from '../product-detail/rating-stars-display.js';

export interface ModerationRowProps {
  readonly review: ModerationReviewSummary;
  /** This row's OWN action in flight — never a screen-wide submitting flag, so acting on one row
   * never disables every other row's button (SPEC-0001 S8's "keeps focus on the row so a moderator
   * can act down the list without refinding their place" only holds if the REST of the list stays
   * interactive while one row's mutation is in flight). */
  readonly isPending: boolean;
  /** Set only when THIS row's own reject/restore call failed — scoped the same way `isPending` is. */
  readonly error: ApiError | undefined;
  readonly onReject: () => void;
  readonly onRestore: () => void;
}

/**
 * One row of S8's moderation list (SPEC-0001): product name/slug as a link, rating, title, body,
 * author label, submitted date, current state, and the single-click Reject/Restore action for that
 * state — never both at once, and never a bare icon: the button's own visible text is "Reject"/
 * "Restore", with the FULL "who and what" context carried in `aria-label` instead of repeated
 * visibly down the list (SPEC-0001's own example: "Reject review by A. Rivera on Sony
 * WH-1000XM5").
 */
export function ModerationRow({
  review,
  isPending,
  error,
  onReject,
  onRestore,
}: ModerationRowProps) {
  const isPublished = review.moderationState === 'published';
  const actionLabel = isPublished
    ? `Reject review by ${review.authorLabel} on ${review.productName}`
    : `Restore review by ${review.authorLabel} on ${review.productName}`;

  return (
    <li className="list-none">
      <Card>
        <CardContent className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <Link
              to="/products/$productSlug"
              params={{ productSlug: review.productSlug }}
              className="text-body font-semibold underline-offset-2 hover:underline"
            >
              {review.productName}
            </Link>
            <span className="text-caption text-content-muted">{review.moderationState}</span>
          </div>
          <div className="flex items-center gap-2">
            <RatingStarsDisplay average={review.rating} />
            <span className="text-body font-semibold">{review.title}</span>
          </div>
          <p className="text-body whitespace-pre-wrap">{review.body}</p>
          <span className="text-caption text-content-muted">
            {review.authorLabel} · {new Date(review.createdAt).toLocaleDateString()}
          </span>

          {error !== undefined && <FieldError>{errorMessageFor(error.code)}</FieldError>}

          <div>
            <Button
              type="button"
              variant={isPublished ? 'outline' : undefined}
              disabled={isPending}
              aria-label={actionLabel}
              onClick={isPublished ? onReject : onRestore}
            >
              {isPending ? (
                <>
                  <Spinner size="inline" label={isPublished ? 'Rejecting…' : 'Restoring…'} />
                  {isPublished ? 'Rejecting…' : 'Restoring…'}
                </>
              ) : isPublished ? (
                'Reject'
              ) : (
                'Restore'
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </li>
  );
}
