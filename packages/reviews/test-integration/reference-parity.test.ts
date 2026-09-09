import { PRODUCT_CATEGORY, REVIEW_MODERATION_STATE } from '@repo/entities';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ReviewsTestInfra, startReviewsTestInfra } from './harness/postgres-container.js';

/**
 * SPEC-0002's parity proof, named by the spec itself and by `internal/reference-ids.ts`'s INV-3
 * doc comment: `reference.product_category` and `reference.review_moderation_state`, as seeded by
 * `packages/persistence/migrations/0004-create-reviews.ts`, must equal `PRODUCT_CATEGORY` /
 * `REVIEW_MODERATION_STATE` in `@repo/entities` EXACTLY — not merely agree with this module's own
 * compile-time lookups, which `test/reference-ids.test.ts` already pins against the literal
 * seeded ids without ever touching a database. `toStrictEqual` against the WHOLE ordered array
 * (`packages/jobs/test-integration/reference-parity.test.ts`'s own pattern): a renamed value, a
 * renumbered id, a missing row, or an extra unseeded row all change the array and all go red —
 * none of those changes is invisible to a per-row `toContain`/`toHaveLength` check the way it
 * would be to a weaker assertion.
 */
describe('reference vocabulary seed matches @repo/entities (SPEC-0002)', () => {
  let infra: ReviewsTestInfra;

  beforeAll(async () => {
    infra = await startReviewsTestInfra();
  }, 180_000);

  afterAll(async () => {
    await infra.stop();
  }, 60_000);

  // Mutation: in `@repo/entities`' `product-category.entity.ts`, rename `Kitchen`'s `name` from
  // 'kitchen' to 'kitchenware' (or renumber any id) WITHOUT touching the migration's seed
  // `VALUES` — the array `toStrictEqual` compares no longer matches at that entry, and this goes
  // red. Equally: delete one seeded row directly in the migration (or insert an extra one) — the
  // arrays differ in length and this still goes red.
  it('reference.product_category equals PRODUCT_CATEGORY exactly', async () => {
    const rows = await sql`
      SELECT product_category_id, name FROM reference.product_category ORDER BY product_category_id
    `.execute(infra.db);
    expect(rows.rows).toStrictEqual(
      Object.values(PRODUCT_CATEGORY)
        .sort((a, b) => a.id - b.id)
        .map((entry) => ({ product_category_id: entry.id, name: entry.name })),
    );
  });

  // Mutation: in `@repo/entities`' `review-moderation-state.entity.ts`, rename `Pending`'s `name`
  // from 'pending' to 'in_review' without touching the migration's seed `VALUES` — this goes red.
  it('reference.review_moderation_state equals REVIEW_MODERATION_STATE exactly', async () => {
    const rows = await sql`
      SELECT review_moderation_state_id, name FROM reference.review_moderation_state
      ORDER BY review_moderation_state_id
    `.execute(infra.db);
    expect(rows.rows).toStrictEqual(
      Object.values(REVIEW_MODERATION_STATE)
        .sort((a, b) => a.id - b.id)
        .map((entry) => ({ review_moderation_state_id: entry.id, name: entry.name })),
    );
  });
});
