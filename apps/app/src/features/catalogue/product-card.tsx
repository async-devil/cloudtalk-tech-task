import type { ProductSummary } from '@repo/contracts';
import { Card, CardContent } from '@repo/styles';
import { Link } from '@tanstack/react-router';
import { formatPriceMinor } from '../../shared/formatting/money.js';
import { formatComputedAt } from '../../shared/formatting/relative-time.js';
import { RatingStarsDisplay } from './rating-stars-display.js';

export interface ProductCardProps {
  readonly product: ProductSummary;
}

/**
 * The catalogue card (SPEC-0001 S2): name, category, price, rating, and the "rated … ago" line.
 *
 * The WHOLE card is the `<Link>` — not a `<div onClick>` wrapping one — so it is a single real
 * anchor a keyboard user can reach and activate, matching S2's own keyboard contract ("every card
 * is a link"). `Card`/`CardContent` supply the surface styling only (`card.tsx`'s own doc: "NON-
 * INTERACTIVE by design"); the interactivity and its focus ring come entirely from `Link`.
 */
export function ProductCard({ product }: ProductCardProps) {
  return (
    <Link
      to="/products/$productSlug"
      params={{ productSlug: product.slug }}
      className="block rounded-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus-ring)"
    >
      <Card className="h-full transition-colors hover:bg-surface-sunken">
        <CardContent className="flex flex-col gap-2">
          <span className="text-caption text-content-muted">{product.categoryName}</span>
          <span className="text-title font-semibold">{product.name}</span>
          <span className="text-body">
            {formatPriceMinor(product.priceMinor, product.currencyCode)}
          </span>

          {product.rating.ratingAverage === null ? (
            <span className="text-caption text-content-muted">No reviews yet</span>
          ) : (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <RatingStarsDisplay average={product.rating.ratingAverage} />
                <span className="text-caption text-content-muted">
                  {product.rating.ratingAverage.toFixed(1)} ({product.rating.reviewCount})
                </span>
              </div>
              {product.rating.computedAt !== null && (
                <span className="text-caption text-content-muted">
                  rated {formatComputedAt(product.rating.computedAt)}
                </span>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

/** A skeleton the same shape as {@link ProductCard} — SPEC-0001 S2's "no layout shift" loading
 * state. Fixed heights matching a real card's rendered content rather than an aspect-ratio guess. */
export function ProductCardSkeleton() {
  return (
    <Card aria-hidden="true">
      <CardContent className="flex flex-col gap-2">
        <div className="h-4 w-20 animate-pulse rounded-control bg-surface-sunken" />
        <div className="h-5 w-3/4 animate-pulse rounded-control bg-surface-sunken" />
        <div className="h-4 w-16 animate-pulse rounded-control bg-surface-sunken" />
        <div className="h-4 w-24 animate-pulse rounded-control bg-surface-sunken" />
      </CardContent>
    </Card>
  );
}
