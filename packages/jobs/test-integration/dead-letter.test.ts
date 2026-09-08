import { BRANCH_KIND, BRANCH_STATUS, STAGE_STATUS } from '@repo/entities';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimStage, registerBranches, writeDeadLetter } from '../src/index.js';
import {
  FIXTURE_CONTRACT,
  type JobsTestInfra,
  startJobsTestInfra,
} from './harness/postgres-container.js';

async function insertWidget(db: Kysely<unknown>): Promise<string> {
  const result = await sql`
    INSERT INTO test_pipeline.widget DEFAULT VALUES RETURNING widget_id
  `.execute(db);
  return (result.rows[0] as { widget_id: string }).widget_id;
}

describe('writeDeadLetter', () => {
  let infra: JobsTestInfra;

  beforeAll(async () => {
    infra = await startJobsTestInfra();
  }, 180_000);

  afterAll(async () => {
    await infra.stop();
  }, 60_000);

  it('inserts the row, fails the stage, and closes every still-pending branch of (instance, stage) in one transaction', async () => {
    const widgetId = await insertWidget(infra.db);
    await claimStage({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
      attemptsCeiling: 10,
    });
    await infra.db.transaction().execute((trx) =>
      registerBranches(trx, FIXTURE_CONTRACT, {
        instanceId: widgetId,
        stage: 'stage_a',
        branches: [
          { branchKey: 'one', kind: BRANCH_KIND.Owned.id },
          { branchKey: 'two', kind: BRANCH_KIND.Delegated.id },
        ],
      }),
    );

    await writeDeadLetter(infra.db, FIXTURE_CONTRACT, {
      instanceId: widgetId,
      stage: 'stage_a',
      reason: 'provider permanently rejected the request',
      attempts: 3,
      payload: { itemId: widgetId },
    });

    const stageRow = await sql`
      SELECT stage_a_stage_status_id FROM test_pipeline.widget WHERE widget_id = ${widgetId}
    `.execute(infra.db);
    expect((stageRow.rows[0] as { stage_a_stage_status_id: number }).stage_a_stage_status_id).toBe(
      STAGE_STATUS.Failed.id,
    );

    const branchRows = await sql`
      SELECT branch_key, branch_status_id, last_error FROM test_pipeline.widget_branch
      WHERE widget_id = ${widgetId} AND stage = 'stage_a' ORDER BY branch_key
    `.execute(infra.db);
    expect(branchRows.rows).toStrictEqual([
      {
        branch_key: 'one',
        branch_status_id: BRANCH_STATUS.Failed.id,
        last_error: 'provider permanently rejected the request',
      },
      {
        branch_key: 'two',
        branch_status_id: BRANCH_STATUS.Failed.id,
        last_error: 'provider permanently rejected the request',
      },
    ]);

    const dlqRows = await sql`
      SELECT branch_key, reason, attempts, payload FROM jobs.dead_letter
      WHERE pipeline = 'widget' AND instance_id = ${widgetId} AND stage = 'stage_a'
    `.execute(infra.db);
    expect(dlqRows.rows).toStrictEqual([
      {
        branch_key: null,
        reason: 'provider permanently rejected the request',
        attempts: 3,
        payload: { itemId: widgetId },
      },
    ]);
  });

  it('is replay-safe (ON CONFLICT DO NOTHING on pipeline/instance/stage/branch_key)', async () => {
    const widgetId = await insertWidget(infra.db);
    await claimStage({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
      attemptsCeiling: 10,
    });

    await writeDeadLetter(infra.db, FIXTURE_CONTRACT, {
      instanceId: widgetId,
      stage: 'stage_a',
      reason: 'first reason',
      attempts: 1,
    });
    await writeDeadLetter(infra.db, FIXTURE_CONTRACT, {
      instanceId: widgetId,
      stage: 'stage_a',
      reason: 'second reason (must not create a second row)',
      attempts: 2,
    });

    const rows = await sql`
      SELECT reason FROM jobs.dead_letter
      WHERE pipeline = 'widget' AND instance_id = ${widgetId} AND stage = 'stage_a'
    `.execute(infra.db);
    expect(rows.rows).toStrictEqual([{ reason: 'first reason' }]);
  });

  it('truncates reason to 500 characters', async () => {
    const widgetId = await insertWidget(infra.db);
    await claimStage({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
      attemptsCeiling: 10,
    });
    await writeDeadLetter(infra.db, FIXTURE_CONTRACT, {
      instanceId: widgetId,
      stage: 'stage_a',
      reason: 'x'.repeat(600),
      attempts: 1,
    });
    const rows = await sql`
      SELECT reason FROM jobs.dead_letter
      WHERE pipeline = 'widget' AND instance_id = ${widgetId} AND stage = 'stage_a'
    `.execute(infra.db);
    expect((rows.rows[0] as { reason: string }).reason).toHaveLength(500);
  });

  it('runs inside the caller-supplied transaction when db.isTransaction is true', async () => {
    const widgetId = await insertWidget(infra.db);
    await claimStage({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
      attemptsCeiling: 10,
    });

    let rolledBack = false;
    try {
      await infra.db.transaction().execute(async (trx) => {
        await writeDeadLetter(trx, FIXTURE_CONTRACT, {
          instanceId: widgetId,
          stage: 'stage_a',
          reason: 'rolled back on purpose',
          attempts: 1,
        });
        throw new Error('force rollback');
      });
    } catch {
      rolledBack = true;
    }
    expect(rolledBack).toBe(true);

    const rows = await sql`
      SELECT 1 FROM jobs.dead_letter
      WHERE pipeline = 'widget' AND instance_id = ${widgetId} AND stage = 'stage_a'
    `.execute(infra.db);
    // The dead-letter insert was part of the rolled-back caller transaction — it must not exist.
    expect(rows.rows).toHaveLength(0);
  });
});
