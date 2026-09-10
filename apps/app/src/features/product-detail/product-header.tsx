import type { ProductDetail } from '@repo/contracts';
import { Card, CardContent } from '@repo/styles';
import { formatPriceMinor } from '../../shared/formatting/money.js';
import { formatComputedAt } from '../../shared/formatting/relative-time.js';
import { RatingStarsDisplay } from './rating-stars-display.js';

export interface ProductHeaderProps {
  readonly product: ProductDetail;
}

/**
 * S3's header (SPEC-0001): name, category, price, SKU, description, and the aggregate spelled out
 * — "Average from 24 reviews, calculated 2 minutes ago" — or "No reviews yet" per rule 14. No
 * "Edit product" affordance in this wave (TASK-0008 adds it once `/products/$slug/edit` exists).
 */
export function ProductHeader({ product }: ProductHeaderProps) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <span className="text-caption text-content-muted">{product.categoryName}</span>
        <h1 className="text-display">{product.name}</h1>
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
