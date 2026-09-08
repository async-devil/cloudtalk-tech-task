import { BRANCH_KIND, BRANCH_STATUS } from '@repo/entities';
import { InternalError } from '@repo/kernel';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  completeBranch,
  failBranch,
  JOIN_DECISION,
  registerBranches,
  runPipelineBranch,
  STAGE_RUN_OUTCOME,
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

async function branchStatus(
  db: Kysely<unknown>,
  widgetId: string,
  branchKey: string,
): Promise<number> {
  const result = await sql`
    SELECT branch_status_id FROM test_pipeline.widget_branch
    WHERE widget_id = ${widgetId} AND stage = 'stage_b' AND branch_key = ${branchKey}
  `.execute(db);
  return (result.rows[0] as { branch_status_id: number }).branch_status_id;
}

describe('registerBranches / completeBranch / runPipelineBranch', () => {
  let infra: JobsTestInfra;

  beforeAll(async () => {
    infra = await startJobsTestInfra();
  }, 180_000);

  afterAll(async () => {
    await infra.stop();
  }, 60_000);

  it('completeBranch-count: the join decision is CompletedNow exactly once, on the branch that closes the last one', async () => {
    const widgetId = await insertWidget(infra.db);
    await infra.db.transaction().execute((trx) =>
      registerBranches(trx, FIXTURE_CONTRACT, {
        instanceId: widgetId,
        stage: 'stage_b',
        branches: [
          { branchKey: 'search', kind: BRANCH_KIND.Owned.id },
          { branchKey: 'analytics', kind: BRANCH_KIND.Delegated.id },
        ],
      }),
    );

    const first = await completeBranch(infra.db, FIXTURE_CONTRACT, {
      instanceId: widgetId,
      stage: 'stage_b',
      branchKey: 'search',
    });
    expect(first).toBe(JOIN_DECISION.Pending);

    const second = await completeBranch(infra.db, FIXTURE_CONTRACT, {
      instanceId: widgetId,
      stage: 'stage_b',
      branchKey: 'analytics',
    });
    expect(second).toBe(JOIN_DECISION.CompletedNow);

    // Replaying the branch that already closed the join is a safe no-op — never CompletedNow twice.
    const replay = await completeBranch(infra.db, FIXTURE_CONTRACT, {
      instanceId: widgetId,
      stage: 'stage_b',
      branchKey: 'analytics',
    });
    expect(replay).toBe(JOIN_DECISION.Pending);
  });

  it('registerBranches is idempotent (ON CONFLICT DO NOTHING) — re-registering does not reset a completed branch', async () => {
    const widgetId = await insertWidget(infra.db);
    await infra.db.transaction().execute((trx) =>
      registerBranches(trx, FIXTURE_CONTRACT, {
        instanceId: widgetId,
        stage: 'stage_b',
        branches: [{ branchKey: 'search', kind: BRANCH_KIND.Owned.id }],
      }),
    );
    await completeBranch(infra.db, FIXTURE_CONTRACT, {
      instanceId: widgetId,
      stage: 'stage_b',
      branchKey: 'search',
    });
    await infra.db.transaction().execute((trx) =>
      registerBranches(trx, FIXTURE_CONTRACT, {
        instanceId: widgetId,
        stage: 'stage_b',
        branches: [{ branchKey: 'search', kind: BRANCH_KIND.Owned.id }],
      }),
    );
    expect(await branchStatus(infra.db, widgetId, 'search')).toBe(BRANCH_STATUS.Completed.id);
  });

  it('failBranch increments attempts and records last_error on a still-pending branch only', async () => {
    const widgetId = await insertWidget(infra.db);
    await infra.db.transaction().execute((trx) =>
      registerBranches(trx, FIXTURE_CONTRACT, {
        instanceId: widgetId,
        stage: 'stage_b',
        branches: [{ branchKey: 'search', kind: BRANCH_KIND.Owned.id }],
      }),
    );
    await failBranch(infra.db, FIXTURE_CONTRACT, {
      instanceId: widgetId,
      stage: 'stage_b',
      branchKey: 'search',
      reason: 'provider timeout',
    });
    const row = await sql`
      SELECT attempts, last_error FROM test_pipeline.widget_branch
      WHERE widget_id = ${widgetId} AND stage = 'stage_b' AND branch_key = 'search'
    `.execute(infra.db);
    expect((row.rows[0] as { attempts: number; last_error: string }).attempts).toBe(1);
    expect((row.rows[0] as { attempts: number; last_error: string }).last_error).toBe(
      'provider timeout',
    );
  });

  it('runPipelineBranch: fires onJoinCompleted exactly once when it closes the last branch', async () => {
    const widgetId = await insertWidget(infra.db);
    await infra.db.transaction().execute((trx) =>
      registerBranches(trx, FIXTURE_CONTRACT, {
        instanceId: widgetId,
        stage: 'stage_b',
        branches: [
          { branchKey: 'search', kind: BRANCH_KIND.Owned.id },
          { branchKey: 'analytics', kind: BRANCH_KIND.Delegated.id },
        ],
      }),
    );
    // Close "analytics" out of band (as a delegated callback would), leaving "search" as the
    // owned branch runPipelineBranch drives.
    await completeBranch(infra.db, FIXTURE_CONTRACT, {
      instanceId: widgetId,
      stage: 'stage_b',
      branchKey: 'analytics',
    });

    let joinCompletedCount = 0;
    let callCount = 0;
    const outcome = await runPipelineBranch({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      branch: { instanceId: widgetId, stage: 'stage_b', branchKey: 'search' },
      attemptsCeiling: 5,
      resultSchema,
      performExternalCall: () => {
        callCount += 1;
        return Promise.resolve({ value: 'ok' });
      },
      applyResult: () => Promise.resolve(),
      onJoinCompleted: () => {
        joinCompletedCount += 1;
        return Promise.resolve();
      },
    });

    expect(outcome).toBe(STAGE_RUN_OUTCOME.Completed);
    expect(callCount).toBe(1);
    expect(joinCompletedCount).toBe(1);

    // Replaying the same branch job must not re-bill or re-fire the join.
    const replay = await runPipelineBranch({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      branch: { instanceId: widgetId, stage: 'stage_b', branchKey: 'search' },
      attemptsCeiling: 5,
      resultSchema,
      performExternalCall: () => {
        callCount += 1;
        return Promise.resolve({ value: 'ok' });
      },
      applyResult: () => Promise.resolve(),
      onJoinCompleted: () => {
        joinCompletedCount += 1;
        return Promise.resolve();
      },
    });
    expect(replay).toBe(STAGE_RUN_OUTCOME.ReplayNoOp);
    expect(callCount).toBe(1);
    expect(joinCompletedCount).toBe(1);
  });

  it('branch ceiling: every branch kind dead-letters identically once attempts exceed the ceiling', async () => {
    const widgetId = await insertWidget(infra.db);
    await infra.db.transaction().execute((trx) =>
      registerBranches(trx, FIXTURE_CONTRACT, {
        instanceId: widgetId,
        stage: 'stage_b',
        branches: [{ branchKey: 'search', kind: BRANCH_KIND.Owned.id }],
      }),
    );

    let callCount = 0;
    const runOnce = () =>
      runPipelineBranch({
        db: infra.db,
        contract: FIXTURE_CONTRACT,
        branch: { instanceId: widgetId, stage: 'stage_b', branchKey: 'search' },
        attemptsCeiling: 1,
        resultSchema,
        performExternalCall: () => {
          callCount += 1;
          throw new Error('always fails');
        },
        applyResult: () => Promise.resolve(),
        onJoinCompleted: () => Promise.resolve(),
      });

    // First attempt: retryable (unknown error defaults retry), rethrows without dead-lettering.
    await expect(runOnce()).rejects.toThrow('always fails');
    // Second claim exceeds the ceiling (1) — dead-lettered at claim time before any provider call.
    await expect(runOnce()).rejects.toThrow(InternalError);
    expect(callCount).toBe(1);

    expect(await branchStatus(infra.db, widgetId, 'search')).toBe(BRANCH_STATUS.Failed.id);
    const deadLetterRows = await sql`
      SELECT branch_key FROM jobs.dead_letter
      WHERE pipeline = 'widget' AND instance_id = ${widgetId} AND stage = 'stage_b'
    `.execute(infra.db);
    expect(deadLetterRows.rows).toStrictEqual([{ branch_key: 'search' }]);

    const afterDlq = await runPipelineBranch({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      branch: { instanceId: widgetId, stage: 'stage_b', branchKey: 'search' },
      attemptsCeiling: 1,
      resultSchema,
      performExternalCall: () => {
        callCount += 1;
        return Promise.resolve({ value: 'unreachable' });
      },
      applyResult: () => Promise.resolve(),
      onJoinCompleted: () => Promise.resolve(),
    });
    expect(afterDlq).toBe(STAGE_RUN_OUTCOME.AlreadyFailed);
    expect(callCount).toBe(1);
  });
});
