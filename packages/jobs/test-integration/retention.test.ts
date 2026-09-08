import { OUTBOX_ROW_STATUS } from '@repo/entities';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  insertOutboxRows,
  purgeDeadLetters,
  purgePipelineData,
  writeStageResult,
} from '../src/index.js';
import {
  FIXTURE_CONTRACT,
  FIXTURE_OUTBOX,
  type JobsTestInfra,
  startJobsTestInfra,
} from './harness/postgres-container.js';

const resultSchema = z.object({ value: z.string() });

async function insertWidget(db: Kysely<unknown>): Promise<string> {
  const result = await sql`
    INSERT INTO test_pipeline.widget DEFAULT VALUES RETURNING widget_id
  `.execute(db);
  return (result.rows[0] as { widget_id: string }).widget_id;
}

async function backdateStageResult(
  db: Kysely<unknown>,
  widgetId: string,
  stage: string,
): Promise<void> {
  await sql`
    UPDATE test_pipeline.widget_stage_result
    SET created_at = now() - interval '1 hour'
    WHERE widget_id = ${widgetId} AND attempt_token = ${stage}
  `.execute(db);
}

async function backdateOutboxRow(db: Kysely<unknown>, aggregateId: string): Promise<void> {
  await sql`
    UPDATE test_pipeline.outbox SET created_at = now() - interval '1 hour'
    WHERE aggregate_id = ${aggregateId}
  `.execute(db);
}

describe('purgePipelineData / purgeDeadLetters', () => {
  let infra: JobsTestInfra;

  beforeAll(async () => {
    infra = await startJobsTestInfra();
  }, 180_000);

  afterAll(async () => {
    await infra.stop();
  }, 60_000);

  it('purges over-horizon stage results and keeps under-horizon rows', async () => {
    const oldWidgetId = await insertWidget(infra.db);
    const freshWidgetId = await insertWidget(infra.db);
    await writeStageResult({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: oldWidgetId,
      result: { value: 'old' },
      resultSchema,
    });
    await writeStageResult({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: freshWidgetId,
      result: { value: 'fresh' },
      resultSchema,
    });
    await backdateStageResult(infra.db, oldWidgetId, 'stage_a');

    const report = await purgePipelineData({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stageResultRetainMs: 1_000, // 1s: the 1-hour-old row is purged, the fresh row is not
      staleAfterMs: 100,
    });

    expect(report.stageResultsPurged).toBeGreaterThanOrEqual(1);

    const remaining = await sql`
      SELECT widget_id FROM test_pipeline.widget_stage_result WHERE attempt_token = 'stage_a'
    `.execute(infra.db);
    const remainingIds = remaining.rows.map((row) => (row as { widget_id: string }).widget_id);
    expect(remainingIds).not.toContain(oldWidgetId);
    expect(remainingIds).toContain(freshWidgetId);
  });

  it('purges over-horizon Processed/Dead outbox rows, keeps under-horizon and every Pending row', async () => {
    const processedOld = `processed-old-${crypto.randomUUID()}`;
    const processedFresh = `processed-fresh-${crypto.randomUUID()}`;
    const deadOld = `dead-old-${crypto.randomUUID()}`;
    const pendingOld = `pending-old-${crypto.randomUUID()}`;

    await infra.db.transaction().execute((trx) =>
      insertOutboxRows(trx, FIXTURE_OUTBOX, [
        { aggregateId: processedOld, op: 'test.op', payload: {} },
        { aggregateId: processedFresh, op: 'test.op', payload: {} },
        { aggregateId: deadOld, op: 'test.op', payload: {} },
        { aggregateId: pendingOld, op: 'test.op', payload: {} },
      ]),
    );

    await sql`
      UPDATE test_pipeline.outbox SET outbox_row_status_id = ${OUTBOX_ROW_STATUS.Processed.id}, processed_at = now()
      WHERE aggregate_id IN (${processedOld}, ${processedFresh})
    `.execute(infra.db);
    await sql`
      UPDATE test_pipeline.outbox SET outbox_row_status_id = ${OUTBOX_ROW_STATUS.Dead.id}
      WHERE aggregate_id = ${deadOld}
    `.execute(infra.db);
    // pendingOld stays Pending (default) — never touched by retention regardless of age.

    await backdateOutboxRow(infra.db, processedOld);
    await backdateOutboxRow(infra.db, deadOld);
    await backdateOutboxRow(infra.db, pendingOld);

    const report = await purgePipelineData({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      outbox: FIXTURE_OUTBOX,
      stageResultRetainMs: 60_000,
      processedOutboxRetainMs: 1_000,
      deadOutboxRetainMs: 1_000,
      staleAfterMs: 100,
    });

    expect(report.outboxProcessedPurged).toBeGreaterThanOrEqual(1);
    expect(report.outboxDeadPurged).toBeGreaterThanOrEqual(1);

    const remaining = await sql`SELECT aggregate_id FROM test_pipeline.outbox`.execute(infra.db);
    const remainingIds = remaining.rows.map(
      (row) => (row as { aggregate_id: string }).aggregate_id,
    );
    expect(remainingIds).not.toContain(processedOld);
    expect(remainingIds).not.toContain(deadOld);
    expect(remainingIds).toContain(processedFresh);
    expect(remainingIds).toContain(pendingOld); // Pending is NEVER purged, however old
  });

  it('purgeDeadLetters purges only the named pipeline, leaves other pipelines untouched', async () => {
    const widgetId = await insertWidget(infra.db);
    await sql`
      INSERT INTO jobs.dead_letter (pipeline, instance_id, stage, reason, attempts)
      VALUES ('widget', ${widgetId}, 'stage_a', 'retention-proof row', 1)
    `.execute(infra.db);
    await sql`
      INSERT INTO jobs.dead_letter (pipeline, instance_id, stage, reason, attempts)
      VALUES ('other-pipeline', ${widgetId}, 'stage_a', 'must survive', 1)
    `.execute(infra.db);
    await sql`
      UPDATE jobs.dead_letter SET created_at = now() - interval '1 hour'
      WHERE instance_id = ${widgetId}
    `.execute(infra.db);

    const purged = await purgeDeadLetters({
      db: infra.db,
      pipeline: 'widget',
      retainMs: 1_000,
      staleAfterMs: 100,
    });
    expect(purged).toBeGreaterThanOrEqual(1);

    const remaining = await sql`
      SELECT pipeline FROM jobs.dead_letter WHERE instance_id = ${widgetId}
    `.execute(infra.db);
    expect(remaining.rows).toStrictEqual([{ pipeline: 'other-pipeline' }]);
  });
});
