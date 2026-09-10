import type { ReviewSummary } from '@repo/contracts';
import { RatingStarsDisplay } from './rating-stars-display.js';

export interface ReviewCardProps {
  readonly review: ReviewSummary;
}

/** One row in the review list (SPEC-0001 S3): rating, title, body, author label, submitted date,
 * and an "edited" marker when `updatedAt !== createdAt` (rule 6). */
export function ReviewCard({ review }: ReviewCardProps) {
  const edited = review.updatedAt !== review.createdAt;
  return (
    <li className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0">
      <div className="flex items-center gap-2">
        <RatingStarsDisplay average={review.rating} />
        <span className="text-body font-semibold">{review.title}</span>
      </div>
      <p className="text-body whitespace-pre-wrap">{review.body}</p>
      <span className="text-caption text-content-muted">
        {review.authorLabel} · {new Date(review.createdAt).toLocaleDateString()}
        {edited ? ' · edited' : ''}
      </span>
    </li>
  );
}
