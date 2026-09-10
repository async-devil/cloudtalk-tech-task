import { NotFoundError, ValidationError } from '@repo/kernel';
import { rowAs, rowsAs } from '@repo/persistence';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { acquireReviewLock } from './internal/advisory-lock.js';
import { decodeCursor, encodeCursor } from './internal/cursor.js';
import { emitRatingRecompute } from './internal/emit-rating-recompute.js';
import { obs } from './internal/observability.js';
import { reviewModerationStateIdFor } from './internal/reference-ids.js';
import {
  moderationReviewListRowSchema,
  reviewModerationRowSchema,
  reviewRowSchema,
} from './internal/rows.js';

/** The wire-legal moderation states a caller may ever name (SPEC-0002, SPEC-0003): `pending` is
 * seeded but reachable through no route this module implements. */
export type ModerationState = 'published' | 'rejected';

// -------------------------------------------------------------------------------------------
// setReviewModerationState (TASK-0009, SPEC-0001 rules 9-12, SPEC-0004, ADR-0018) — the ONE
// function reading two target states the task's own note asks for: "reject and restore are the
// same operation in reverse ... the pipeline should not grow two independent code paths that
// happen to look similar." The router calls it once with `targetState: 'rejected'` (reject) and
// once with `targetState: 'published'` (restore); nothing below branches on which caller it was.
// -------------------------------------------------------------------------------------------

export interface SetReviewModerationStateInput {
  readonly reviewToken: string;
  readonly targetState: ModerationState;
}

/**
 * `setReviewModerationState`'s result. `authorId` is the SAME deliberate, narrow exception
 * {@link ../reviews.js!ReviewListItem} documents: the router needs it to resolve `authorLabel`
 * (the REVIEW's author, never the acting moderator) and `authoredByViewer` against the calling
 * session — this module has no sanctioned edge to `@repo/auth` to resolve either itself. Never log
 * it, put it on a span attribute, or a metric (ADR-0009) — the same treatment every other
 * `authorId` in this package already gets.
 *
 * `moderationState` is always the CALLER'S `input.targetState` — every return path (a genuine
 * transition, the pre-transaction no-op, or the post-race re-read) settles on exactly that value
 * by construction, so it is threaded through directly rather than re-derived from a row's raw
 * `review_moderation_state_id`, which would need to fend off a `'pending'` this module never
 * writes and no caller of this function can ever request.
 */
export interface ReviewModerationRecord {
  readonly token: string;
  readonly rating: number;
  readonly title: string;
  readonly body: string;
  readonly authorId: string;
  readonly moderationState: ModerationState;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

type ModerationRow = z.infer<typeof reviewModerationRowSchema>;
type ReviewRow = z.infer<typeof reviewRowSchema>;

function toModerationRecord(
  row: ModerationRow,
  moderationState: ModerationState,
): ReviewModerationRecord {
  return {
    token: row.token,
    rating: row.rating,
    title: row.title,
    body: row.body,
    authorId: row.author_id,
    moderationState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toModerationRecordFromUpdate(
  row: ReviewRow,
  authorId: string,
  moderationState: ModerationState,
): ReviewModerationRecord {
  return {
    token: row.token,
    rating: row.rating,
    title: row.title,
    body: row.body,
    authorId,
    moderationState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Reads a review's current row by token, `product_id`/`author_id` included — the shape both the
 * pre-transaction state check and the post-lock race re-read need (see
 * {@link setReviewModerationState}'s doc comment, steps 1 and 6).
 * @throws NotFoundError when no review has this token.
 */
async function readModerationRow(db: Kysely<unknown>, reviewToken: string): Promise<ModerationRow> {
  const result = await sql`
    SELECT token, product_id, author_id, rating, title, body, review_moderation_state_id,
           created_at, updated_at
    FROM reviews.review
    WHERE token = ${reviewToken}
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) {
    throw new NotFoundError(`no review with token "${reviewToken}"`);
  }
  return rowAs(reviewModerationRowSchema, row);
}

/**
 * Reject/restore (SPEC-0001 rules 9-12, SPEC-0003 `reviews.reject`/`reviews.restore`, SPEC-0004) —
 * ADR-0007's six steps, adapted from {@link ../reviews.js!updateReview}'s shape with the ownership
 * guard removed (a moderator acts on ANY review, never only their own) and a state-equality no-op
 * branch playing the role `submitReview`'s replay branch plays:
 *
 * 1. **State check**, outside any transaction: {@link readModerationRow} resolves the review's
 *    CURRENT `review_moderation_state_id`, `product_id` and `author_id` by token —
 *    `NotFoundError` for a token that names no row at all (unlike `updateReview`'s ownership
 *    guard, there is no ambiguity to hide here: a moderator with the capability may already see
 *    any review through `listReviewsForModeration`, so confirming a token does not exist reveals
 *    nothing an existence oracle could exploit — SPEC-0003 states the `NOT_FOUND` answer directly).
 *    Already AT `input.targetState`? This is a no-op: return the current row verbatim and open no
 *    transaction, enqueuing NOTHING (TASK-0009's own criterion — "does not enqueue a second
 *    recomputation").
 * 2. **Claim**: the transaction's FIRST statement is the advisory lock keyed by
 *    `(product_id, author_id)` — the SAME lock `submitReview`/`updateReview` take, so a moderation
 *    transition can never interleave with either function's own decision for that pair.
 * 3. **External call**: none, for the identical reason `submitReview` names its absence.
 * 4. **Write-ahead**: not applicable, same reasoning.
 * 5. **Single commit**: `UPDATE ... WHERE token = ... AND review_moderation_state_id = <the state
 *    read in step 1> RETURNING ...` re-asserts that outside-transaction read INSIDE the statement
 *    itself — the same optimistic-concurrency shape `updateReview`'s `WHERE token = ... AND
 *    author_id = ...` demonstrates, here guarding against a RACE (the state changed between step 1
 *    and the lock), never against ownership — plus `emitRatingRecompute` in the SAME transaction.
 * 6. **Typed failure / race branch**: zero rows back from the `UPDATE` means step 5's re-assertion
 *    failed — the state moved between step 1's read and the lock. With only two states reachable
 *    through this module's contract (`pending` is seeded but unwritten, SPEC-0002), the row can
 *    only now be sitting AT `input.targetState` already: some concurrent caller made the identical
 *    transition first. Re-read the row UNDER the lock (never outside it, or this would race again)
 *    and return it as the same no-op outcome step 1 would have taken, enqueuing nothing — this is
 *    the "typed-failure branch" doing the same job `submitReview`'s post-rollback re-read does,
 *    just without a rollback, since nothing here can violate a constraint.
 */
export function setReviewModerationState(
  db: Kysely<unknown>,
  input: SetReviewModerationStateInput,
): Promise<ReviewModerationRecord> {
  return obs.withSpan('reviews.review.moderate', async (span) => {
    const targetStateId = reviewModerationStateIdFor(input.targetState);
    const before = await readModerationRow(db, input.reviewToken);

    if (before.review_moderation_state_id === targetStateId) {
      span.setAttributes({
        outcome: 'noop',
        targetState: input.targetState,
        reviewToken: input.reviewToken,
      });
      return toModerationRecord(before, input.targetState);
    }

    const { record, changed } = await db.transaction().execute(async (trx) => {
      await acquireReviewLock(trx, before.product_id, before.author_id);

      const updateResult = await sql`
        UPDATE reviews.review
        SET review_moderation_state_id = ${targetStateId}
        WHERE token = ${input.reviewToken}
          AND review_moderation_state_id = ${before.review_moderation_state_id}
        RETURNING token, rating, title, body, review_moderation_state_id, created_at, updated_at
      `.execute(trx);
      const row = updateResult.rows[0];
      if (row === undefined) {
        const raced = await readModerationRow(trx, input.reviewToken);
        return { record: toModerationRecord(raced, input.targetState), changed: false };
      }

      const updated = rowAs(reviewRowSchema, row);
      await emitRatingRecompute(trx, before.product_id);
      return {
        record: toModerationRecordFromUpdate(updated, before.author_id, input.targetState),
        changed: true,
      };
    });

    span.setAttributes({
      outcome: changed ? 'changed' : 'noop',
      targetState: input.targetState,
      reviewToken: input.reviewToken,
    });
    return record;
  });
}

// ---------------------------------------------------------------------------------------------
// listReviewsForModeration (TASK-0009, SPEC-0001 S8, SPEC-0003) — UNLIKE listReviewsForProduct,
// this reads across every product and filters by moderation STATE rather than by product, and is
// never scoped to `published` only: it is the one read in this package that returns a review
// regardless of state (the caller just names which one).
// ---------------------------------------------------------------------------------------------

export interface ModerationReviewListItem {
  readonly token: string;
  readonly rating: number;
  readonly title: string;
  readonly body: string;
  /** The SAME deliberate, narrow exception {@link ReviewModerationRecord.authorId} documents. */
  readonly authorId: string;
  readonly productName: string;
  readonly productSlug: string;
  /** The page's own `state` filter, restated per row (`moderationReviewSummarySchema`, SPEC-0001
   * S8: "current state") — every row in one page shares this value BY CONSTRUCTION (the query
   * filters on it), so it is threaded through from the input rather than re-derived from each
   * row's raw `review_moderation_state_id`, the same reasoning
   * {@link ReviewModerationRecord.moderationState} documents. */
  readonly moderationState: ModerationState;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ModerationReviewListPage {
  readonly items: readonly ModerationReviewListItem[];
  readonly nextCursor: string | null;
}

export interface ListReviewsForModerationInput {
  /** @default 'published' */
  readonly state?: ModerationState;
  readonly cursor?: string;
  readonly limit: number;
}

/** The opaque cursor's decoded shape — scoped to `state` the same way `listReviewsForProduct`'s is
 * scoped to `productSlug` (a cursor minted under one state filter is rejected against the other,
 * never silently honoured). `token`, not `review_id`, for the identical ADR-0016 reason that
 * schema's own doc gives. */
const moderationListCursorSchema = z.object({
  v: z.literal(1),
  state: z.enum(['published', 'rejected']),
  createdAt: z.string(),
  token: z.string(),
});

/**
 * `reviews.moderationList`'s read (SPEC-0001 S8, SPEC-0003): newest-first, keyset-paginated the
 * same way as `listReviewsForProduct`, but scoped by moderation STATE (default `'published'`)
 * rather than by product, and joined to `reviews.product` for the name/slug every row carries
 * (SPEC-0001 S8: "each row showing the product name and slug"). `input.limit` is trusted as
 * already validated, the same precedent every other list in this package documents.
 * @throws ValidationError when `cursor` does not decode, or names a different state filter.
 */
export function listReviewsForModeration(
  db: Kysely<unknown>,
  input: ListReviewsForModerationInput,
): Promise<ModerationReviewListPage> {
  return obs.withSpan('reviews.review.moderation-list', async () => {
    const state = input.state ?? 'published';
    const stateId = reviewModerationStateIdFor(state);

    let cursorFilter = sql``;
    if (input.cursor !== undefined) {
      const cursor = decodeCursor(input.cursor, moderationListCursorSchema);
      if (cursor.state !== state) {
        throw new ValidationError('cursor does not match the requested state filter', {
          details: { field: 'cursor' },
        });
      }
      cursorFilter = sql`
        AND (r.created_at < ${cursor.createdAt}::timestamptz
             OR (r.created_at = ${cursor.createdAt}::timestamptz AND r.token < ${cursor.token}))
      `;
    }

    const result = await sql`
      SELECT r.token, r.rating, r.title, r.body, r.author_id, r.review_moderation_state_id,
             p.name AS product_name, p.slug AS product_slug, r.created_at, r.updated_at
      FROM reviews.review r
      JOIN reviews.product p ON p.product_id = r.product_id
      WHERE r.review_moderation_state_id = ${stateId}
        ${cursorFilter}
      ORDER BY r.created_at DESC, r.token DESC
      LIMIT ${input.limit + 1}
    `.execute(db);
    const rows = rowsAs(moderationReviewListRowSchema, result.rows);

    const page = rows.slice(0, input.limit);
    const hasMore = rows.length > input.limit;
    const last = page[page.length - 1];
    const nextCursor: string | null =
      hasMore && last !== undefined
        ? encodeCursor({
            v: 1,
            state,
            createdAt: last.created_at.toISOString(),
            token: last.token,
          } satisfies z.infer<typeof moderationListCursorSchema>)
        : null;

    return {
      items: page.map((row) => ({
        token: row.token,
        rating: row.rating,
        title: row.title,
        body: row.body,
        authorId: row.author_id,
        productName: row.product_name,
        productSlug: row.product_slug,
        moderationState: state,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      nextCursor,
    };
  });
}
