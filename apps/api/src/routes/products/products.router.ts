import { implement } from '@orpc/server';
import { requireCatalogueManager } from '@repo/auth';
import {
  appContract,
  type ProductDetail,
  type ProductSummary,
  type RatingAggregate,
} from '@repo/contracts';
import {
  createProduct,
  getProductBySlug,
  listProducts,
  type ProductDetailRecord,
  type ProductRatingSummary,
  type ProductRecord,
  type ProductSummaryRecord,
  updateProduct,
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

/** `createProduct`'s response shape (SPEC-0003): a freshly created product carries `{
 * reviewCount: 0, ratingAverage: null, computedAt: null }` — there is no `reviews.product_rating`
 * row yet and none is owed (SPEC-0004) — synthesized here rather than read back, since `@repo/reviews`
 * writes NO projection row on creation (`createProduct`'s own doc) for there to be a row to read. */
function toCreatedProductDetail(record: ProductRecord): ProductDetail {
  return {
    slug: record.slug,
    sku: record.sku,
    name: record.name,
    categoryName: record.categoryName,
    priceMinor: record.priceMinor,
    currencyCode: record.currencyCode,
    description: record.description,
    rating: { reviewCount: 0, ratingAverage: null, computedAt: null },
  };
}

/**
 * Implements `appContract.products` (TASK-0003, TASK-0008, SPEC-0003). `list`/`get` are anonymous
 * reads over `@repo/reviews`'s catalogue functions, which themselves read the rating PROJECTION
 * (`reviews.product_rating` LEFT JOINed to `reviews.product`), never the authoritative review rows
 * (ADR-0014) — visible here in which module functions this router calls, with no comment required
 * to say so. A thin translation between wire shapes and module calls, per TASK-0003's own words:
 * every domain decision (pagination, cursor validation, the category/query filters) lives in
 * `@repo/reviews`, and this file's only job is building the module's input from the wire input and
 * the wire output from the module's result.
 *
 * `create`/`update` require the `catalogue_manager` capability (TASK-0008, ADR-0018):
 * `requireCatalogueManager` runs FIRST in each handler, before `requireDb`/any `@repo/reviews` call
 * — an anonymous or under-capability caller never reaches the pipeline, mirroring
 * `reviews.router.ts`'s own `requireSession`-before-everything-else precedent for the write routes
 * TASK-0003 already implemented. `createProduct`/`updateProduct` themselves carry NO capability
 * logic (`@repo/reviews`'s own docs) — that split is ADR-0008/ADR-0018's: a capability check is an
 * HTTP-boundary concern, never a pipeline one, the same way ownership checks stay HTTP-adjacent
 * while the row-level `WHERE` clause is the pipeline's actual enforcement.
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

    create: impl.create.handler(async ({ input, context }) => {
      try {
        requireCatalogueManager(context);
        const activeDb = requireDb(db);
        const record = await createProduct(activeDb, {
          sku: input.sku,
          name: input.name,
          description: input.description,
          categoryName: input.categoryName,
          priceMinor: input.priceMinor,
          currencyCode: input.currencyCode,
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
        });
        return toCreatedProductDetail(record);
      } catch (error) {
        throw toOrpcError(error, context);
      }
    }),

    update: impl.update.handler(async ({ input, context }) => {
      try {
        requireCatalogueManager(context);
        const activeDb = requireDb(db);
        await updateProduct(activeDb, {
          productSlug: input.productSlug,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.categoryName !== undefined ? { categoryName: input.categoryName } : {}),
          ...(input.priceMinor !== undefined ? { priceMinor: input.priceMinor } : {}),
          ...(input.currencyCode !== undefined ? { currencyCode: input.currencyCode } : {}),
        });
        // A fresh read, not the UPDATE's own RETURNING: `updateProduct` returns no `rating`
        // (SPEC-0004 — editing mutable fields never touches the aggregate), and this route's
        // output is the full `productDetail` including whatever the product's CURRENT rating is —
        // unlike `create`, an edited product may already have reviews. `getProductBySlug` reads the
        // projection the same way `products.get` does (ADR-0014).
        const detail = await getProductBySlug(activeDb, input.productSlug);
        return toProductDetail(detail);
      } catch (error) {
        throw toOrpcError(error, context);
      }
    }),
  });
}
