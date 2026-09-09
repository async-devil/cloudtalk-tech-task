import { z } from 'zod';

/**
 * The review-moderation-state vocabulary (ADR-0006, ADR-0016) — the single source
 * `reference.review_moderation_state` is seeded from
 * (`packages/persistence/migrations/0004-create-reviews.ts`) and
 * `packages/reviews/test-integration/reference-parity.test.ts` pins. See {@link STAGE_STATUS}
 * (`jobs/stage-status.entity.ts`) for why the `{ id, name }` record shape is frozen. Ids are the
 * contract — they appear in `reviews.review.review_moderation_state_id` — and are never renumbered.
 *
 * Every review is created `Published`. A moderator (ADR-0018) may transition a review between
 * `Published` and `Rejected` — the same plain `UPDATE` of `review_moderation_state_id` whichever
 * direction it moves, so "reject" and "restore" are one code path reading two different target ids
 * rather than two. `Pending` is seeded and closes the vocabulary at three values, but nothing in v1
 * writes it: SPEC-0002 reserves it for a future reporting flow. A reader who finds it unused in
 * every `WHERE` clause has found the reserved seam, not a bug.
 */
export const REVIEW_MODERATION_STATE = {
  Published: { id: 1, name: 'published' },
  /** Seeded, never written by anything in v1 — reserved for a future reporting flow
   * (SPEC-0002). */
  Pending: { id: 2, name: 'pending' },
  Rejected: { id: 3, name: 'rejected' },
} as const;
export type ReviewModerationStateId =
  (typeof REVIEW_MODERATION_STATE)[keyof typeof REVIEW_MODERATION_STATE]['id'];
export type ReviewModerationStateName =
  (typeof REVIEW_MODERATION_STATE)[keyof typeof REVIEW_MODERATION_STATE]['name'];

/** The `reference.review_moderation_state` row shape (ADR-0004 raw-SQL parse boundary). */
export const reviewModerationStateRowSchema = z.object({
  review_moderation_state_id: z.number().int(),
  name: z.string(),
});
export type ReviewModerationStateRow = z.infer<typeof reviewModerationStateRowSchema>;
