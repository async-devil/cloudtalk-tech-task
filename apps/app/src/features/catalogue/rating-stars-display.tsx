import { cn } from '@repo/styles';

/**
 * A READ-ONLY five-star glyph row — the catalogue card's rating display (SPEC-0001 S2).
 *
 * Deliberately NOT `@repo/styles`' `StarRating`: that primitive is a `role="radiogroup"` of five
 * real, individually-focusable `<input type="radio">` elements (SPEC-0001 S4's interactive rating
 * control). Reusing it here to merely SHOW a number would hand every catalogue card five extra tab
 * stops that do nothing — a keyboard trap a card has no business adding, and semantically wrong
 * besides (a card's rating is a fact about the product, not a choice a visitor makes). This is
 * `product-detail`'s own header display (`features/product-detail/rating-stars-display.tsx`) too —
 * duplicated on purpose rather than promoted to `shared/`: `shared/` in this codebase is the
 * non-visual app kernel (API client, query keys, error handling, session — ADR-0012's own list,
 * `formatComputedAt` the one prior precedent for "two slices need it"), and every existing `.ts`
 * file under it is plain TypeScript with no JSX. A ~20-line read-only glyph row is cheaper to keep
 * in sync by eye across two slices than to be the first visual component to open that door.
 */
export interface RatingStarsDisplayProps {
  /** The aggregate average (1–5). Callers branch on `ratingAverage === null` themselves and render
   * "No reviews yet" instead of this component (SPEC-0001 rule 14) — this prop is never `null`. */
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

/** `aria-hidden`: the row's single accessible name comes from the wrapping `role="img"` span above
 * — a screen reader must not additionally walk five unlabelled glyphs. */
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
