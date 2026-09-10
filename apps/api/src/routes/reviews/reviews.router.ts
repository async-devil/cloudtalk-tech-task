import { implement } from '@orpc/server';
import { authorLabelsForUserIds, requireSession } from '@repo/auth';
import { appContract, type ReviewSummary } from '@repo/contracts';
import { listReviewsForProduct, removeReview, submitReview, updateReview } from '@repo/reviews';
import type { Kysely } from 'kysely';
import { type HttpRequestContext, toOrpcError } from '../../http/error-mapper.js';
import { requireDb } from '../require-db.js';

const AUTHOR_LABEL_FALLBACK = 'Reviewer';

/** The one shape every review-bearing wire response shares (`reviewSummarySchema`), built from
 * whichever of `@repo/reviews`'s three record shapes (`ReviewRecord`, `ReviewMutationRecord`,
 * `ReviewListItem`) the caller has in hand — all three carry these six fields, which is all this
 * function reads. `authorLabel`/`authoredByViewer` are never derivable from the module record
 * alone (SPEC-0003's own doc on both fields), so they arrive as explicit arguments instead. */
function toReviewSummary(
  review: {
    readonly token: string;
    readonly rating: number;
    readonly title: string;
    readonly body: string;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  },
  authorLabel: string,
  authoredByViewer: boolean,
): ReviewSummary {
  return {
    token: review.token,
    rating: review.rating,
    title: review.title,
    body: review.body,
    authorLabel,
    authoredByViewer,
    createdAt: review.createdAt.toISOString(),
    updatedAt: review.updatedAt.toISOString(),
  };
}

/** Resolves the CALLING session's own `authorLabel` — `submit`/`update` always describe the
 * caller's own review, so there is exactly one id to resolve, never a batch. */
async function ownAuthorLabel(db: Kysely<unknown>, userId: string): Promise<string> {
  const labels = await authorLabelsForUserIds(db, [userId]);
  return labels.get(userId) ?? AUTHOR_LABEL_FALLBACK;
}

/**
 * Implements `appContract.reviews` (TASK-0003, SPEC-0003). `listForProduct` reads
 * `@repo/reviews`'s `listReviewsForProduct` — the AUTHORITATIVE `reviews.review` table, never the
 * rating projection `products.*` reads (ADR-0014) — which is the split TASK-0003 asks to keep
 * visible in the router without a comment explaining it: this namespace boundary, and which
 * module function each handler below calls, IS that comment. `submit`/`update`/`remove` require a
 * resolved session (`requireSession`, thrown BEFORE `requireDb`/any module call runs, mirroring
 * `session.router.ts`'s own precedent) — an anonymous caller never reaches `@repo/reviews` at all.
 *
 * `authorLabel` never comes from `@repo/reviews` (it has no sanctioned edge to `@repo/auth`'s
 * `auth.identity` table — ADR-0001): this router is the composition-root seam that correlates a
 * review's `authorId` (an internal id `@repo/reviews` hands back for exactly this reason — see
 * `ReviewListItem`'s own doc) against `@repo/auth`'s `authorLabelsForUserIds`. The email itself
 * never reaches this file; only the derived label does.
 */
export function createReviewsRouter(db: Kysely<unknown> | undefined) {
  const impl = implement<typeof appContract.reviews, HttpRequestContext>(appContract.reviews);

  return impl.router({
    listForProduct: impl.listForProduct.handler(async ({ input, context }) => {
      try {
        const activeDb = requireDb(db);
        const page = await listReviewsForProduct(activeDb, {
          productSlug: input.productSlug,
          limit: input.limit,
          ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        });
        const viewerId = context.session?.userId;
        const labels = await authorLabelsForUserIds(
          activeDb,
          page.items.map((item) => item.authorId),
        );
        return {
          items: page.items.map((item) =>
            toReviewSummary(
              item,
              labels.get(item.authorId) ?? AUTHOR_LABEL_FALLBACK,
              item.authorId === viewerId,
            ),
          ),
          nextCursor: page.nextCursor,
        };
      } catch (error) {
        throw toOrpcError(error, context);
      }
    }),

    submit: impl.submit.handler(async ({ input, context }) => {
      try {
        const session = requireSession(context);
        const activeDb = requireDb(db);
        const result = await submitReview(activeDb, {
          productSlug: input.productSlug,
          authorId: session.userId,
          rating: input.rating,
          title: input.title,
          body: input.body,
        });
        const label = await ownAuthorLabel(activeDb, session.userId);
        return toReviewSummary(result.review, label, true);
      } catch (error) {
        throw toOrpcError(error, context);
      }
    }),

    update: impl.update.handler(async ({ input, context }) => {
      try {
        const session = requireSession(context);
        const activeDb = requireDb(db);
        const result = await updateReview(activeDb, {
          reviewToken: input.reviewToken,
          authorId: session.userId,
          ...(input.rating !== undefined ? { rating: input.rating } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
        });
        const label = await ownAuthorLabel(activeDb, session.userId);
        return toReviewSummary(result, label, true);
      } catch (error) {
        throw toOrpcError(error, context);
      }
    }),

    remove: impl.remove.handler(async ({ input, context }) => {
      try {
        const session = requireSession(context);
        await removeReview(requireDb(db), {
          reviewToken: input.reviewToken,
          authorId: session.userId,
        });
        return { token: input.reviewToken };
      } catch (error) {
        throw toOrpcError(error, context);
      }
    }),
  });
}
