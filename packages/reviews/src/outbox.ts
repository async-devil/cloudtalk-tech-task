import type { OutboxTableRef } from '@repo/jobs';

/**
 * This context's own outbox table (ADR-0007, SPEC-0004): `reviews.outbox`, created by
 * `packages/persistence/migrations/0004-create-reviews.ts` in the shape `@repo/jobs`'s relay
 * reads. Each bounded context owns its own outbox rather than sharing one — `@repo/jobs` takes it
 * as this `OutboxTableRef` and never string-builds a qualified name.
 */
export const REVIEWS_OUTBOX: OutboxTableRef = { schema: 'reviews', table: 'outbox' };

/**
 * The one operation this context's outbox ever carries (SPEC-0004): every write that changes
 * which reviews count toward a product's aggregate — submission today; edit, delete, and the two
 * moderation transitions in later tasks — emits it, with an empty payload. A recomputation reads
 * the authoritative `reviews.review` table; anything carried in the payload would be a second,
 * staler copy of what the worker is about to read anyway.
 */
export const RATING_RECOMPUTE_OP = 'rating.recompute';
