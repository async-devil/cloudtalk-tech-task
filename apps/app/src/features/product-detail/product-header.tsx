import type { ProductDetail } from '@repo/contracts';
import { Button, Card, CardContent } from '@repo/styles';
import { Link } from '@tanstack/react-router';
import type { Ref } from 'react';
import { formatPriceMinor } from '../../shared/formatting/money.js';
import { formatComputedAt } from '../../shared/formatting/relative-time.js';
import { RatingStarsDisplay } from './rating-stars-display.js';

export interface ProductHeaderProps {
  readonly product: ProductDetail;
  /**
   * TASK-0008: gates the "Edit product" affordance — supplied by the ROUTE (which already reads
   * `useSession()` for the review form's own sign-in-prompt branch), the same `isSignedIn`-as-prop
   * precedent `review-submit-form.tsx` establishes, rather than this presentational component
   * reading `shared/session` itself. COURTESY only: `products.update`'s own `requireCatalogueManager`
   * guard is the actual boundary regardless of this prop's value.
   */
  readonly canManageCatalogue: boolean;
  /** TASK-0008: focused after a successful product creation ("on success focus lands on the new
   * product's heading", SPEC-0001 S7) — owned and cleared by the route, this component only
   * attaches it. */
  readonly headingRef?: Ref<HTMLHeadingElement>;
}

/**
 * S3's header (SPEC-0001): name, category, price, SKU, description, and the aggregate spelled out
 * — "Average from 24 reviews, calculated 2 minutes ago" — or "No reviews yet" per rule 14. TASK-0008
 * adds the "Edit product" affordance, rendered only for a catalogue manager.
 */
export function ProductHeader({ product, canManageCatalogue, headingRef }: ProductHeaderProps) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <span className="text-caption text-content-muted">{product.categoryName}</span>
          {canManageCatalogue && (
            <Button type="button" asChild variant="outline" size="sm">
              <Link
                to="/products/$productSlug/edit"
                params={{ productSlug: product.slug }}
                data-testid="edit-product-link"
              >
                Edit product
              </Link>
            </Button>
          )}
        </div>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="text-display outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus-ring)"
        >
          {product.name}
        </h1>
        <span className="text-caption text-content-muted">SKU {product.sku}</span>
        <span className="text-title font-semibold">
          {formatPriceMinor(product.priceMinor, product.currencyCode)}
        </span>
        <p className="text-body">{product.description}</p>

        {product.rating.ratingAverage === null ? (
          <p className="text-body text-content-muted">No reviews yet</p>
        ) : (
          <div className="flex items-center gap-2">
            <RatingStarsDisplay average={product.rating.ratingAverage} />
            <span className="text-body">
              Average from {product.rating.reviewCount} review
              {product.rating.reviewCount === 1 ? '' : 's'}
              {product.rating.computedAt !== null
                ? `, calculated ${formatComputedAt(product.rating.computedAt)}`
                : ''}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** SPEC-0001 S3's "header skeleton, then list skeleton, so the product renders before its
 * reviews" — this is the header half. */
export function ProductHeaderSkeleton() {
  return (
    <Card aria-hidden="true">
      <CardContent className="flex flex-col gap-2">
        <div className="h-4 w-24 animate-pulse rounded-control bg-surface-sunken" />
        <div className="h-7 w-1/2 animate-pulse rounded-control bg-surface-sunken" />
        <div className="h-4 w-32 animate-pulse rounded-control bg-surface-sunken" />
        <div className="h-16 w-full animate-pulse rounded-control bg-surface-sunken" />
      </CardContent>
    </Card>
  );
}
