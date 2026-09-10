import { insertOutboxRows } from '@repo/jobs';
import type { Kysely } from 'kysely';
import { RATING_RECOMPUTE_OP, REVIEWS_OUTBOX } from '../outbox.js';

/**
 * The one recomputation event every write path that changes which reviews count toward a
 * product's aggregate emits (SPEC-0004): submission, edit, delete (`reviews.ts`), and both
 * moderation transitions (`moderation.ts`). Extracted so every call site shares IDENTICAL wiring
 * rather than each defining its own `insertOutboxRows` call — TASK-0009's own note: "there is no
 * moderation-specific event type, because the worker recomputes from the authoritative table
 * regardless of what changed it."
 *
 * MUST be called with the caller's own OPEN transaction (`trx`), never the pooled `db` — the same
 * commit that changes `reviews.review` is the commit that schedules its recomputation (ADR-0007
 * step 5, SPEC-0004: "no window where the state changed and no recomputation was scheduled").
 */
export async function emitRatingRecompute(trx: Kysely<unknown>, productId: string): Promise<void> {
  await insertOutboxRows(trx, REVIEWS_OUTBOX, [
    { aggregateId: productId, op: RATING_RECOMPUTE_OP, payload: {} },
  ]);
}
