import { BRANCH_KIND, BRANCH_STATUS, OUTBOX_ROW_STATUS, STAGE_STATUS } from '@repo/entities';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type JobsTestInfra, startJobsTestInfra } from './harness/postgres-container.js';

/**
 * A lightweight parity check on THIS package's own migration (`migrations/0002-create-jobs-spine.ts`)
 * — not the full ADR-0011 parity proof (proof 7), which is
 * `packages/reviews/test-integration/reference-parity.test.ts`'s job since it must also cover the
 * reviews pipeline's own tables. This proves jobs' migration seeded exactly what
 * `@repo/entities` declares, so a spine bug never hides behind an untested seed statement.
 */
describe('reference vocabulary seed matches @repo/entities (proof 7, jobs-migration scope)', () => {
  let infra: JobsTestInfra;

  beforeAll(async () => {
    infra = await startJobsTestInfra();
  }, 180_000);

  afterAll(async () => {
    await infra.stop();
  }, 60_000);

  it('reference.stage_status equals STAGE_STATUS exactly', async () => {
    const rows = await sql`
      SELECT stage_status_id, name FROM reference.stage_status ORDER BY stage_status_id
    `.execute(infra.db);
    expect(rows.rows).toStrictEqual(
      Object.values(STAGE_STATUS)
        .sort((a, b) => a.id - b.id)
        .map((entry) => ({ stage_status_id: entry.id, name: entry.name })),
    );
  });

  it('reference.branch_status equals BRANCH_STATUS exactly', async () => {
    const rows = await sql`
      SELECT branch_status_id, name FROM reference.branch_status ORDER BY branch_status_id
    `.execute(infra.db);
    expect(rows.rows).toStrictEqual(
      Object.values(BRANCH_STATUS)
        .sort((a, b) => a.id - b.id)
        .map((entry) => ({ branch_status_id: entry.id, name: entry.name })),
    );
  });

  it('reference.branch_kind equals BRANCH_KIND exactly', async () => {
    const rows = await sql`
      SELECT branch_kind_id, name FROM reference.branch_kind ORDER BY branch_kind_id
    `.execute(infra.db);
    expect(rows.rows).toStrictEqual(
      Object.values(BRANCH_KIND)
        .sort((a, b) => a.id - b.id)
        .map((entry) => ({ branch_kind_id: entry.id, name: entry.name })),
    );
  });

  it('reference.outbox_row_status equals OUTBOX_ROW_STATUS exactly', async () => {
    const rows = await sql`
      SELECT outbox_row_status_id, name FROM reference.outbox_row_status ORDER BY outbox_row_status_id
    `.execute(infra.db);
    expect(rows.rows).toStrictEqual(
      Object.values(OUTBOX_ROW_STATUS)
        .sort((a, b) => a.id - b.id)
        .map((entry) => ({ outbox_row_status_id: entry.id, name: entry.name })),
    );
  });
});
