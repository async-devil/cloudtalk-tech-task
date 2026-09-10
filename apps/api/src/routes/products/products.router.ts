import { implement } from '@orpc/server';
import {
  appContract,
  type ProductDetail,
  type ProductSummary,
  type RatingAggregate,
} from '@repo/contracts';
import {
  getProductBySlug,
  listProducts,
  type ProductDetailRecord,
  type ProductRatingSummary,
  type ProductSummaryRecord,
} from '@repo/reviews';
import type { Kysely } from 'kysely';
import { type HttpRequestContext, toOrpcError } from '../../http/error-mapper.js';
import { requireDb } from '../require-db.js';

/**
 * The one wire/storage bridge SPEC-0003's `ratingAggregateSchema` doc assigns to the router:
 * `@repo/reviews` hands back `ratingAverage` as a Postgres `numeric` STRING (never converted
 * there, on purpose — see that module's README) and `computedAt` as a `Date | null`; the wire
 * wants `number | null` and an ISO string respectively. `Number(string)` is exact here because the
 * source is a `numeric(3,2)` string a Postgres round-trip already produced — never user input.
 */
function toRatingAggregate(rating: ProductRatingSummary): RatingAggregate {
  return {
    reviewCount: rating.reviewCount,
    ratingAverage: rating.ratingAverage === null ? null : Number(rating.ratingAverage),
    computedAt: rating.computedAt === null ? null : rating.computedAt.toISOString(),
  };
}

function toProductSummary(record: ProductSummaryRecord): ProductSummary {
  return {
    slug: record.slug,
    sku: record.sku,
    name: record.name,
    categoryName: record.categoryName,
    priceMinor: record.priceMinor,
    currencyCode: record.currencyCode,
    rating: toRatingAggregate(record.rating),
  };
}

function toProductDetail(record: ProductDetailRecord): ProductDetail {
  return { ...toProductSummary(record), description: record.description };
}

/**
 * Implements `appContract.products` (TASK-0003, SPEC-0003): both routes are anonymous reads over
 * `@repo/reviews`'s catalogue functions, which themselves read the rating PROJECTION
 * (`reviews.product_rating` LEFT JOINed to `reviews.product`), never the authoritative review rows
 * (ADR-0014) — visible here in which module functions this router calls, with no comment required
 * to say so. A thin translation between wire shapes and module calls, per TASK-0003's own words:
 * every domain decision (pagination, cursor validation, the category/query filters) lives in
 * `@repo/reviews`, and this file's only job is building the module's input from the wire input and
 * the wire output from the module's result.
 */
export function createProductsRouter(db: Kysely<unknown> | undefined) {
  const impl = implement<typeof appContract.products, HttpRequestContext>(appContract.products);

  return impl.router({
    list: impl.list.handler(async ({ input, context }) => {
      try {
        const page = await listProducts(requireDb(db), {
          sort: input.sort,
          limit: input.limit,
          ...(input.query !== undefined ? { query: input.query } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        });
        return { items: page.items.map(toProductSummary), nextCursor: page.nextCursor };
      } catch (error) {
        throw toOrpcError(error, context);
      }
    }),

    get: impl.get.handler(async ({ input, context }) => {
      try {
        const detail = await getProductBySlug(requireDb(db), input.productSlug);
        return toProductDetail(detail);
      } catch (error) {
        throw toOrpcError(error, context);
      }
    }),
  });
}
