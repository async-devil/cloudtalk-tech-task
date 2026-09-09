import { BRANCH_KIND, BRANCH_STATUS, STAGE_STATUS } from '@repo/entities';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimStage, completeBranch, reconcilePipeline, registerBranches } from '../src/index.js';
import { acquireInstanceLock } from '../src/internal/advisory-lock.js';
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

async function backdateStage(db: Kysely<unknown>, widgetId: string, stage: string): Promise<void> {
  await sql`
    UPDATE test_pipeline.widget
    SET ${sql.id(`${stage}_updated_at`)} = now() - interval '1 hour'
    WHERE widget_id = ${widgetId}
  `.execute(db);
}

/** widget_branch.updated_at is trigger-maintained (tg_widget_branch__set_updated_at) — a plain
 * UPDATE cannot backdate it, the trigger would overwrite it back to now(). Disable for one
 * statement, matching how a real staleness fixture would need to seed aged rows. */
async function backdateBranch(
  db: Kysely<unknown>,
  widgetId: string,
  stage: string,
  branchKey: string,
): Promise<void> {
  await sql`ALTER TABLE test_pipeline.widget_branch DISABLE TRIGGER tg_widget_branch__set_updated_at`.execute(
    db,
  );
  try {
    await sql`
      UPDATE test_pipeline.widget_branch
      SET updated_at = now() - interval '1 hour'
      WHERE widget_id = ${widgetId} AND stage = ${stage} AND branch_key = ${branchKey}
    `.execute(db);
  } finally {
    await sql`ALTER TABLE test_pipeline.widget_branch ENABLE TRIGGER tg_widget_branch__set_updated_at`.execute(
      db,
    );
  }
}

function fakeQueue() {
  const removed: Array<{ instanceId: string; branchKey?: string }> = [];
  const enqueued: Array<{ instanceId: string; branchKey?: string }> = [];
  return {
    removed,
    enqueued,
    remove(instanceId: string, branchKey?: string): Promise<boolean> {
      removed.push({ instanceId, ...(branchKey !== undefined ? { branchKey } : {}) });
      return Promise.resolve(true);
    },
    enqueue(instanceId: string, branchKey?: string): Promise<void> {
      enqueued.push({ instanceId, ...(branchKey !== undefined ? { branchKey } : {}) });
      return Promise.resolve();
    },
  };
}

describe('reconcilePipeline', () => {
  let infra: JobsTestInfra;

  beforeAll(async () => {
    infra = await startJobsTestInfra();
  }, 180_000);

  afterAll(async () => {
    await infra.stop();
  }, 60_000);

  it('redrives a stale in_progress stage (remove then enqueue) and bumps attempts', async () => {
    const widgetId = await insertWidget(infra.db);
    await claimStage({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
      attemptsCeiling: 10,
    });
    await backdateStage(infra.db, widgetId, 'stage_a');

    const queue = fakeQueue();
    const report = await reconcilePipeline({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stages: [{ stage: 'stage_a', remove: queue.remove, enqueue: queue.enqueue }],
      staleAfterMs: 1_000,
      attemptsCeiling: 10,
    });

    expect(report.redriven).toBe(1);
    expect(report.deadLettered).toBe(0);
    expect(queue.removed).toStrictEqual([{ instanceId: widgetId }]);
    expect(queue.enqueued).toStrictEqual([{ instanceId: widgetId }]);

    const row = await sql`
      SELECT stage_a_attempts FROM test_pipeline.widget WHERE widget_id = ${widgetId}
    `.execute(infra.db);
    expect((row.rows[0] as { stage_a_attempts: number }).stage_a_attempts).toBe(2);
  });

  it('dead-letters a stale in_progress stage once attempts reach the ceiling — never redrives past it', async () => {
    const widgetId = await insertWidget(infra.db);
    await claimStage({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
      attemptsCeiling: 10,
    });
    await backdateStage(infra.db, widgetId, 'stage_a');

    const queue = fakeQueue();
    const report = await reconcilePipeline({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stages: [{ stage: 'stage_a', remove: queue.remove, enqueue: queue.enqueue }],
      staleAfterMs: 1_000,
      attemptsCeiling: 1, // already at attempts=1 from the claim above
    });

    expect(report.redriven).toBe(0);
    expect(report.deadLettered).toBe(1);
    expect(queue.removed).toStrictEqual([]);
    expect(queue.enqueued).toStrictEqual([]);

    const row = await sql`
      SELECT stage_a_stage_status_id FROM test_pipeline.widget WHERE widget_id = ${widgetId}
    `.execute(infra.db);
    expect((row.rows[0] as { stage_a_stage_status_id: number }).stage_a_stage_status_id).toBe(
      STAGE_STATUS.Failed.id,
    );
  });

  it('redrives a stale OWNED branch with its branchKey', async () => {
    const widgetId = await insertWidget(infra.db);
    await infra.db.transaction().execute((trx) =>
      registerBranches(trx, FIXTURE_CONTRACT, {
        instanceId: widgetId,
        stage: 'stage_b',
        branches: [{ branchKey: 'search', kind: BRANCH_KIND.Owned.id }],
      }),
    );
    await backdateBranch(infra.db, widgetId, 'stage_b', 'search');

    const queue = fakeQueue();
    const report = await reconcilePipeline({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stages: [{ stage: 'stage_b', remove: queue.remove, enqueue: queue.enqueue }],
      staleAfterMs: 1_000,
      attemptsCeiling: 10,
    });

    expect(report.redriven).toBe(1);
    expect(queue.removed).toStrictEqual([{ instanceId: widgetId, branchKey: 'search' }]);
    expect(queue.enqueued).toStrictEqual([{ instanceId: widgetId, branchKey: 'search' }]);
  });

  it('ages a stale DELEGATED branch (attempts++ only) without ever redriving it, then dead-letters at the same ceiling', async () => {
    const widgetId = await insertWidget(infra.db);
    await infra.db.transaction().execute((trx) =>
      registerBranches(trx, FIXTURE_CONTRACT, {
        instanceId: widgetId,
        stage: 'stage_b',
        branches: [{ branchKey: 'analytics', kind: BRANCH_KIND.Delegated.id }],
      }),
    );
    await backdateBranch(infra.db, widgetId, 'stage_b', 'analytics');

    // Ceiling check compares the CURRENT attempts count (before this pass's increment) — the
    // same "evaluated before the bump" semantics claimStage/claimBranch use. attemptsCeiling: 1
    // means: pass 1 sees attempts=0 (< 1, ages to 1); pass 2 sees attempts=1 (>= 1, dead-letters).
    const queue = fakeQueue();
    const firstPass = await reconcilePipeline({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stages: [{ stage: 'stage_b', remove: queue.remove, enqueue: queue.enqueue }],
      staleAfterMs: 1_000,
      attemptsCeiling: 1,
    });
    expect(firstPass.redriven).toBe(0); // delegated branches are never redriven
    expect(firstPass.deadLettered).toBe(0);
    expect(queue.removed).toStrictEqual([]);
    expect(queue.enqueued).toStrictEqual([]);

    await backdateBranch(infra.db, widgetId, 'stage_b', 'analytics');
    const secondPass = await reconcilePipeline({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stages: [{ stage: 'stage_b', remove: queue.remove, enqueue: queue.enqueue }],
      staleAfterMs: 1_000,
      attemptsCeiling: 1,
    });
    expect(secondPass.deadLettered).toBe(1); // attempts now 1 >= ceiling 1

    const row = await sql`
      SELECT branch_status_id FROM test_pipeline.widget_branch
      WHERE widget_id = ${widgetId} AND stage = 'stage_b' AND branch_key = 'analytics'
    `.execute(infra.db);
    expect((row.rows[0] as { branch_status_id: number }).branch_status_id).toBe(
      BRANCH_STATUS.Failed.id,
    );
  });

  it('heals a missed join: fires onJoinCompleted when every branch is completed but the stage is still pending, past staleness', async () => {
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
    await completeBranch(infra.db, FIXTURE_CONTRACT, {
      instanceId: widgetId,
      stage: 'stage_b',
      branchKey: 'search',
    });
    await completeBranch(infra.db, FIXTURE_CONTRACT, {
      instanceId: widgetId,
      stage: 'stage_b',
      branchKey: 'analytics',
    });
    // stage_b_stage_status_id is still the DEFAULT (Pending) — this widget's stage_b was never
    // claimed; only its branches were driven directly, simulating the row a heal must catch.
    await backdateStage(infra.db, widgetId, 'stage_b');

    const queue = fakeQueue();
    const healedInstances: string[] = [];
    const report = await reconcilePipeline({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stages: [
        {
          stage: 'stage_b',
          remove: queue.remove,
          enqueue: queue.enqueue,
          onJoinCompleted: (instanceId) => {
            healedInstances.push(instanceId);
            return Promise.resolve();
          },
        },
      ],
      staleAfterMs: 1_000,
      attemptsCeiling: 10,
    });

    expect(report.healed).toBe(1);
    expect(healedInstances).toStrictEqual([widgetId]);
  });

  it('does not touch a stage that is not stale, and does not fire onJoinCompleted for an incomplete branch set', async () => {
    const widgetId = await insertWidget(infra.db);
    await claimStage({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
      attemptsCeiling: 10,
    });
    // NOT backdated — freshly claimed, well within staleAfterMs.

    const queue = fakeQueue();
    const report = await reconcilePipeline({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stages: [{ stage: 'stage_a', remove: queue.remove, enqueue: queue.enqueue }],
      staleAfterMs: 60_000,
      attemptsCeiling: 10,
    });

    expect(report).toStrictEqual({ redriven: 0, healed: 0, deadLettered: 0, failed: 0 });
    expect(queue.removed).toStrictEqual([]);
  });

  // Review, 2026-09-09. The stale SELECT runs OUTSIDE the instance lock, so a worker can
  // legitimately re-claim a row in the window before the reconciler acquires it. That re-claim
  // refreshes `{stage}_updated_at` and leaves the status exactly where the scan found it —
  // `in_progress` — so a re-check reading only the status still redrives, putting a second worker
  // on a stage whose external call is already in flight (a second provider charge, in the shape
  // this spine exists to prevent).
  //
  // The window is opened deliberately rather than raced: a holder transaction takes the SAME
  // advisory lock first, the reconciler's SELECT sees the row as stale and then BLOCKS on that
  // lock, and only afterwards does the holder refresh `updated_at` and commit. The reconciler
  // therefore reaches its re-check with a row that is `in_progress` and no longer stale.
  it('does not redrive a stale row re-claimed between the scan and the lock', async () => {
    const widgetId = await insertWidget(infra.db);
    await claimStage({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stage: 'stage_a',
      instanceId: widgetId,
      attemptsCeiling: 10,
    });
    await backdateStage(infra.db, widgetId, 'stage_a');

    let lockHeld: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      lockHeld = resolve;
    });
    const holder = infra.db.transaction().execute(async (trx) => {
      await acquireInstanceLock(trx, FIXTURE_CONTRACT.pipeline, widgetId);
      lockHeld();
      // Long enough for the reconciler's stale SELECT (a single indexed read) to have run and for
      // its transaction to be waiting on this lock.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await sql`
        UPDATE test_pipeline.widget SET stage_a_updated_at = now() WHERE widget_id = ${widgetId}
      `.execute(trx);
    });
    await locked;

    const queue = fakeQueue();
    const report = await reconcilePipeline({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stages: [{ stage: 'stage_a', remove: queue.remove, enqueue: queue.enqueue }],
      staleAfterMs: 1_000,
      attemptsCeiling: 10,
    });
    await holder;

    expect(queue.enqueued).toStrictEqual([]);
    expect(report).toStrictEqual({ redriven: 0, healed: 0, deadLettered: 0, failed: 0 });

    // And the row was left exactly as the re-claiming worker had it: no extra attempt spent.
    const row = await sql`
      SELECT stage_a_attempts FROM test_pipeline.widget WHERE widget_id = ${widgetId}
    `.execute(infra.db);
    expect((row.rows[0] as { stage_a_attempts: number }).stage_a_attempts).toBe(1);
  });

  // Review, 2026-09-09: one unit's redrive throwing used to abandon every unit behind it AND
  // every later step of the pass.
  it('isolates a failing redrive: the rest of the pass still runs', async () => {
    const poison = await insertWidget(infra.db);
    const healthy = await insertWidget(infra.db);
    for (const widgetId of [poison, healthy]) {
      await claimStage({
        db: infra.db,
        contract: FIXTURE_CONTRACT,
        stage: 'stage_a',
        instanceId: widgetId,
        attemptsCeiling: 10,
      });
      await backdateStage(infra.db, widgetId, 'stage_a');
    }

    const enqueued: string[] = [];
    const report = await reconcilePipeline({
      db: infra.db,
      contract: FIXTURE_CONTRACT,
      stages: [
        {
          stage: 'stage_a',
          remove: () => Promise.resolve(true),
          enqueue: (instanceId: string) => {
            if (instanceId === poison) {
              return Promise.reject(new Error('redis blip'));
            }
            enqueued.push(instanceId);
            return Promise.resolve();
          },
        },
      ],
      staleAfterMs: 1_000,
      attemptsCeiling: 10,
    });

    expect(enqueued).toStrictEqual([healthy]);
    expect(report.redriven).toBe(1);
    expect(report.failed).toBe(1);
  });
});
