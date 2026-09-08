import { STAGE_STATUS } from '@repo/entities';
import { InternalError } from '@repo/kernel';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  claimStage,
  completeStage,
  readStageResult,
  runPipelineStage,
  STAGE_RUN_OUTCOME,
  writeStageResult,
} from '../src/index.js';
import {
  FIXTURE_CONTRACT,
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

async function stageStatus(db: Kysely<unknown>, widgetId: string): Promise<number> {
  const result = await sql`
    SELECT stage_a_stage_status_id FROM test_pipeline.widget WHERE widget_id = ${widgetId}
  `.execute(db);
  return (result.rows[0] as { stage_a_stage_status_id: number }).stage_a_stage_status_id;
}

describe('claimStage / completeStage / write-ahead', () => {
  let infra: JobsTestInfra;

  beforeAll(async () => {
    infra = await startJobsTestInfra();
  }, 180_000);

  afterAll(async () => {
    await infra.stop();
  }, 60_000);

  it('claims a pending stage, sets in_progress + attempts = 1', async () => {
    const widgetId = await insertWidget(infra.db);
    const result = await claimStage({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
      attemptsCeiling: 5,
    });
    expect(result).toStrictEqual({ outcome: 'claimed', attempts: 1 });
    expect(await stageStatus(infra.db, widgetId)).toBe(STAGE_STATUS.InProgress.id);
  });

  it('regression guard: claiming an in_progress stage again increments attempts (redrive-safe)', async () => {
    const widgetId = await insertWidget(infra.db);
    await claimStage({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
      attemptsCeiling: 5,
    });
    const second = await claimStage({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
      attemptsCeiling: 5,
    });
    expect(second).toStrictEqual({ outcome: 'claimed', attempts: 2 });
  });

  it('regression guard: claiming a completed stage returns ReplayNoOp without touching attempts', async () => {
    const widgetId = await insertWidget(infra.db);
    await claimStage({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
      attemptsCeiling: 5,
    });
    await completeStage({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
    });
    const replay = await claimStage({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
      attemptsCeiling: 5,
    });
    expect(replay).toStrictEqual({ outcome: STAGE_RUN_OUTCOME.ReplayNoOp });
  });

  it('claim ceiling: attempts exceeding attemptsCeiling dead-letters and throws InternalError', async () => {
    const widgetId = await insertWidget(infra.db);
    // Claim three times with a ceiling of 2: the third claim's attempts (3) exceeds the ceiling.
    await claimStage({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
      attemptsCeiling: 2,
    });
    await claimStage({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
      attemptsCeiling: 2,
    });
    await expect(
      claimStage({
        db: infra.db,
        contract: FIXTURE_CONTRACT,
        stage: 'stage_a',
        instanceId: widgetId,
        attemptsCeiling: 2,
      }),
    ).rejects.toThrow(InternalError);

    expect(await stageStatus(infra.db, widgetId)).toBe(STAGE_STATUS.Failed.id);
    const deadLetterRows = await sql`
      SELECT reason, attempts, payload FROM jobs.dead_letter
      WHERE pipeline = 'widget' AND instance_id = ${widgetId} AND stage = 'stage_a'
    `.execute(infra.db);
    expect(deadLetterRows.rows).toHaveLength(1);
    const row = deadLetterRows.rows[0] as { reason: string; attempts: number; payload: unknown };
    expect(row.reason.length).toBeGreaterThan(0);
    expect(row.attempts).toBe(3);
    expect(row.payload).toBeNull();

    // Claiming again after dead-lettering must ack (AlreadyFailed), never resurrect.
    const afterDlq = await claimStage({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
      attemptsCeiling: 2,
    });
    expect(afterDlq).toStrictEqual({ outcome: STAGE_RUN_OUTCOME.AlreadyFailed });
  });

  it('write-ahead conflict: writeStageResult is idempotent — the first writer wins on ON CONFLICT DO NOTHING', async () => {
    const widgetId = await insertWidget(infra.db);
    const first = await writeStageResult({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
      result: { value: 'first' },
      resultSchema,
    });
    const second = await writeStageResult({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
      result: { value: 'second' },
      resultSchema,
    });
    expect(first).toStrictEqual({ value: 'first' });
    // The SECOND write conflicts and DOES NOT win — the row that exists (the first writer's) is
    // carried forward, exactly as step 4->5 requires.
    expect(second).toStrictEqual({ value: 'first' });

    const read = await readStageResult({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
      resultSchema,
    });
    expect(read).toStrictEqual({ value: 'first' });
  });

  it('readStageResult returns undefined when no attempt has written a result yet', async () => {
    const widgetId = await insertWidget(infra.db);
    const read = await readStageResult({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
      resultSchema,
    });
    expect(read).toBeUndefined();
  });

  it('completeStage regression guard: a lost guard (already completed) is not an error', async () => {
    const widgetId = await insertWidget(infra.db);
    await claimStage({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
      attemptsCeiling: 5,
    });
    const first = await completeStage({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
    });
    const second = await completeStage({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
    });
    expect(first).toStrictEqual({ outcome: 'completed' });
    expect(second).toStrictEqual({ outcome: 'completed' });
    expect(await stageStatus(infra.db, widgetId)).toBe(STAGE_STATUS.Completed.id);
  });

  it('runPipelineStage: replay no-op — a completed stage never calls performExternalCall again', async () => {
    const widgetId = await insertWidget(infra.db);
    let callCount = 0;
    let applyCount = 0;
    let successorCount = 0;
    const runOnce = () =>
      runPipelineStage({
        db: infra.db,
        contract: FIXTURE_CONTRACT,
        stage: 'stage_a',
        instanceId: widgetId,
        attemptsCeiling: 5,
        resultSchema,
        performExternalCall: () => {
          callCount += 1;
          return Promise.resolve({ value: 'enriched' });
        },
        applyResult: () => {
          applyCount += 1;
          return Promise.resolve();
        },
        ensureSuccessors: () => {
          successorCount += 1;
          return Promise.resolve();
        },
      });

    const first = await runOnce();
    const second = await runOnce();

    expect(first).toBe(STAGE_RUN_OUTCOME.Completed);
    expect(second).toBe(STAGE_RUN_OUTCOME.ReplayNoOp);
    expect(callCount).toBe(1);
    expect(applyCount).toBe(1);
    expect(successorCount).toBe(2); // ensureSuccessors fires on every replay too (ADR-0007 step 2)
  });

  it('runPipelineStage: no re-bill when a write-ahead row already exists (crash-between-write-ahead-and-commit simulation)', async () => {
    const widgetId = await insertWidget(infra.db);
    let callCount = 0;

    // Simulate a crash right after the write-ahead write: claim + write the result directly,
    // WITHOUT ever running completeStage — the next runPipelineStage call must find the
    // write-ahead row and skip performExternalCall entirely.
    await claimStage({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
      attemptsCeiling: 5,
    });
    await writeStageResult({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
      result: { value: 'already-billed' },
      resultSchema,
    });

    const outcome = await runPipelineStage({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
      attemptsCeiling: 5,
      resultSchema,
      performExternalCall: () => {
        callCount += 1;
        return Promise.resolve({ value: 'should-not-be-called' });
      },
      applyResult: () => Promise.resolve(),
      ensureSuccessors: () => Promise.resolve(),
    });

    expect(outcome).toBe(STAGE_RUN_OUTCOME.Completed);
    expect(callCount).toBe(0);
  });
});
