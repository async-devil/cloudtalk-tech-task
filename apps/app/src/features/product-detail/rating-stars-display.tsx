import { cn } from '@repo/styles';

/**
 * A READ-ONLY five-star glyph row — the product header's aggregate display and each review's own
 * rating (SPEC-0001 S3). Deliberately duplicated from `features/catalogue/rating-stars-display.tsx`
 * rather than shared — see that file's own doc for the full reasoning (not `StarRating`'s
 * interactive radiogroup; not promoted to `shared/`, which stays non-visual in this codebase).
 */
export interface RatingStarsDisplayProps {
  /** 1–5. Callers branch on a `null` average themselves (SPEC-0001 rule 14) before reaching this
   * component; a review's own `rating` is always a real integer (rule 1) so it never needs that
   * branch. */
  readonly average: number;
  readonly className?: string;
}

const STAR_VALUES = [1, 2, 3, 4, 5] as const;

export function RatingStarsDisplay({ average, className }: RatingStarsDisplayProps) {
  const filledCount = Math.round(average);
  return (
    <span
      className={cn('inline-flex items-center gap-0.5', className)}
      role="img"
      aria-label={`${average.toFixed(1)} out of 5 stars`}
    >
      {STAR_VALUES.map((value) => (
        <StarGlyph key={value} filled={value <= filledCount} />
      ))}
    </span>
  );
}

function StarGlyph({ filled }: { readonly filled: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={cn('size-4', filled ? 'fill-accent text-accent' : 'fill-none text-content-muted')}
    >
      <path
        d="M12 2.5 15.09 8.76 22 9.77 17 14.64 18.18 21.52 12 18.26 5.82 21.52 7 14.64 2 9.77 8.91 8.76 12 2.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}
