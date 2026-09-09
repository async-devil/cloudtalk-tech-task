import { OUTBOX_ROW_STATUS } from '@repo/entities';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertOutboxRows, relayOutboxBatch } from '../src/index.js';
import {
  FIXTURE_OUTBOX,
  type JobsTestInfra,
  startJobsTestInfra,
} from './harness/postgres-container.js';

async function outboxRowStatus(
  db: Kysely<unknown>,
  aggregateId: string,
): Promise<{
  readonly status: number;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly processedAt: Date | null;
}> {
  const result = await sql`
    SELECT outbox_row_status_id, attempts, last_error, processed_at
    FROM test_pipeline.outbox WHERE aggregate_id = ${aggregateId}
  `.execute(db);
  const row = result.rows[0] as {
    outbox_row_status_id: number;
    attempts: number;
    last_error: string | null;
    processed_at: Date | null;
  };
  return {
    status: row.outbox_row_status_id,
    attempts: row.attempts,
    lastError: row.last_error,
    processedAt: row.processed_at,
  };
}

interface DeadLetterRow {
  readonly pipeline: string;
  readonly stage: string;
  readonly reason: string;
  readonly attempts: number;
}

/** `FIXTURE_OUTBOX` (`{ schema: 'test_pipeline', table: 'outbox' }`) never sets
 * `OutboxRelayOptions.pipeline`, so `relayOutboxBatch` defaults it to `outbox.schema` —
 * `'test_pipeline'` — and the stage is `outboxRelayStage`'s own formula,
 * `${toSegment('test_pipeline')}-outbox-relay` = `'test-pipeline-outbox-relay'` (not restated as a
 * literal in `src/outbox.ts`, so it is not restated here as one either — computed in the shared
 * `stageFor` helper below instead). */
function stageFor(schema: string): string {
  return `${schema.replaceAll('_', '-')}-outbox-relay`;
}

async function fetchDeadLetterRows(
  db: Kysely<unknown>,
  pipeline: string,
  instanceId: string,
): Promise<DeadLetterRow[]> {
  const result = await sql`
    SELECT pipeline, stage, reason, attempts FROM jobs.dead_letter
    WHERE pipeline = ${pipeline} AND instance_id = ${instanceId}::uuid
    ORDER BY dead_letter_id
  `.execute(db);
  return result.rows as DeadLetterRow[];
}

describe('insertOutboxRows / relayOutboxBatch', () => {
  let infra: JobsTestInfra;

  beforeAll(async () => {
    infra = await startJobsTestInfra();
  }, 180_000);

  afterAll(async () => {
    await infra.stop();
  }, 60_000);

  it('poison row parks after maxAttempts while siblings commit each pass (per-row isolation)', async () => {
    // A genuine uuid, not `poison-${uuid}` — `jobs.dead_letter.instance_id` is `uuid NOT NULL`
    // (`writeOutboxDeadLetter`'s own uuid guard, `src/dead-letter.ts`), and this test now proves
    // that row gets written on parking, which needs an aggregate id the guard actually accepts.
    const poisonAggregateId = crypto.randomUUID();
    const okAggregateId = `ok-${crypto.randomUUID()}`;
    await infra.db.transaction().execute((trx) =>
      insertOutboxRows(trx, FIXTURE_OUTBOX, [
        { aggregateId: 'before', op: 'test.op', payload: { marker: 'before' } },
        { aggregateId: poisonAggregateId, op: 'test.op', payload: { marker: 'poison' } },
        { aggregateId: okAggregateId, op: 'test.op', payload: { marker: 'ok' } },
      ]),
    );

    const applied: string[] = [];
    const maxAttempts = 3;
    for (let pass = 1; pass <= maxAttempts; pass += 1) {
      const report = await relayOutboxBatch({
        db: infra.db,
        outbox: FIXTURE_OUTBOX,
        maxAttempts,
        apply: (row) => {
          if (row.aggregateId === poisonAggregateId) {
            throw new Error(`poison row apply failure (pass ${pass})`);
          }
          applied.push(row.aggregateId);
          return Promise.resolve();
        },
      });
      expect(report.claimed).toBeGreaterThan(0);
    }

    // Siblings processed on the FIRST pass despite the poison row failing in the same pass.
    expect(applied).toContain('before');
    expect(applied).toContain(okAggregateId);
    expect(applied.filter((id) => id === 'before')).toHaveLength(1);

    const poisonState = await outboxRowStatus(infra.db, poisonAggregateId);
    expect(poisonState.status).toBe(OUTBOX_ROW_STATUS.Dead.id);
    expect(poisonState.attempts).toBe(maxAttempts);
    expect(poisonState.lastError).toContain('poison row apply failure');

    // SPEC-0004: parking writes a `jobs.dead_letter` triage row, in the SAME claim transaction as
    // the park (`writeOutboxDeadLetter`, called from `relayOutboxBatch`'s parking branch).
    // Mutation: in `src/outbox.ts`'s `relayOutboxBatch`, delete the `await writeOutboxDeadLetter(trx, {...})`
    // call in the parking branch — `deadLetterRows` comes back empty and every assertion below
    // goes red.
    const deadLetterRows = await fetchDeadLetterRows(
      infra.db,
      FIXTURE_OUTBOX.schema,
      poisonAggregateId,
    );
    expect(deadLetterRows).toHaveLength(1);
    // Mutation: change `OutboxRelayOptions.pipeline`'s default in `relayOutboxBatch` from
    // `options.outbox.schema` to a hardcoded string (or drop the default and pass `undefined`
    // through) — this assertion goes red because the written row's `pipeline` no longer matches
    // `FIXTURE_OUTBOX.schema`.
    expect(deadLetterRows[0]?.pipeline).toBe(FIXTURE_OUTBOX.schema);
    // Mutation: in `src/outbox.ts`'s `outboxRelayStage`, change the formula's suffix from
    // `-outbox-relay` to anything else — this assertion goes red because `stageFor` (this file's
    // own independent restatement of the SAME formula) would no longer match what got written.
    expect(deadLetterRows[0]?.stage).toBe(stageFor(FIXTURE_OUTBOX.schema));
    // Mutation: in `src/outbox.ts`'s parking branch, pass `row.attempts` (pre-increment) instead
    // of `newAttempts` to `writeOutboxDeadLetter` — this assertion goes red (`maxAttempts - 1`, not
    // `maxAttempts`).
    expect(deadLetterRows[0]?.attempts).toBe(maxAttempts);
    expect(deadLetterRows[0]?.reason.length).toBeGreaterThan(0);
    expect(deadLetterRows[0]?.reason).toContain('poison row apply failure');

    // Replay guard: a row that reaches parking a SECOND time (the same instance/stage/branch-key
    // triple — `branch_key` is always NULL for an outbox row) must not create a second
    // `jobs.dead_letter` row. Simulated here by resetting the already-parked row to `Pending` one
    // attempt short of the ceiling and letting the SAME poison `apply` park it again — an honest
    // re-run of the parking branch, not a direct second call to `writeOutboxDeadLetter`.
    // Mutation: in `src/dead-letter.ts`'s `writeOutboxDeadLetter`, change
    // `ON CONFLICT ON CONSTRAINT uq_dead_letter__pipeline_instance_id_stage_branch_key DO NOTHING`
    // to `DO UPDATE SET reason = excluded.reason` — `secondPassDeadLetterRows` would then have a
    // `reason` ending in a LATER pass number than the first row's, and the
    // `toBe(deadLetterRows[0]?.reason)` assertion below goes red.
    await sql`
      UPDATE test_pipeline.outbox
      SET outbox_row_status_id = ${OUTBOX_ROW_STATUS.Pending.id}, attempts = ${maxAttempts - 1}
      WHERE aggregate_id = ${poisonAggregateId}
    `.execute(infra.db);
    await relayOutboxBatch({
      db: infra.db,
      outbox: FIXTURE_OUTBOX,
      maxAttempts,
      apply: (row) => {
        if (row.aggregateId === poisonAggregateId) {
          throw new Error('poison row apply failure (replay pass)');
        }
        return Promise.resolve();
      },
    });
    const rowAfterReplay = await outboxRowStatus(infra.db, poisonAggregateId);
    expect(rowAfterReplay.status).toBe(OUTBOX_ROW_STATUS.Dead.id);
    expect(rowAfterReplay.attempts).toBe(maxAttempts);

    const secondPassDeadLetterRows = await fetchDeadLetterRows(
      infra.db,
      FIXTURE_OUTBOX.schema,
      poisonAggregateId,
    );
    expect(secondPassDeadLetterRows).toHaveLength(1);
    // The FIRST write wins under `ON CONFLICT DO NOTHING` — the row's `reason` still names the
    // original pass, not the replay.
    expect(secondPassDeadLetterRows[0]?.reason).toBe(deadLetterRows[0]?.reason);

    const okState = await outboxRowStatus(infra.db, okAggregateId);
    expect(okState.status).toBe(OUTBOX_ROW_STATUS.Processed.id);
    expect(okState.processedAt).not.toBeNull();

    // A later relay pass keeps flowing — no wedge from the parked poison row.
    const laterAggregateId = `later-${crypto.randomUUID()}`;
    await infra.db
      .transaction()
      .execute((trx) =>
        insertOutboxRows(trx, FIXTURE_OUTBOX, [
          { aggregateId: laterAggregateId, op: 'test.op', payload: {} },
        ]),
      );
    await relayOutboxBatch({
      db: infra.db,
      outbox: FIXTURE_OUTBOX,
      apply: (row) => {
        applied.push(row.aggregateId);
        return Promise.resolve();
      },
    });
    expect(applied).toContain(laterAggregateId);
  });

  // Mutation: in `src/outbox.ts`'s `relayOutboxBatch`, drop `created_at` from the claim `SELECT`
  // (or from the `apply({ ... })` call it builds) — `capturedCreatedAt` stays `undefined` and the
  // `toBeInstanceOf(Date)`/recency assertions below go red. This is the additive `OutboxRow.createdAt`
  // field TASK-0005 adds for `reviews.rating.lag`.
  it('the claimed row carries createdAt (a Date close to insertion time)', async () => {
    const aggregateId = `created-at-${crypto.randomUUID()}`;
    const beforeInsert = Date.now();
    await infra.db
      .transaction()
      .execute((trx) =>
        insertOutboxRows(trx, FIXTURE_OUTBOX, [{ aggregateId, op: 'test.op', payload: {} }]),
      );

    let capturedCreatedAt: Date | undefined;
    await relayOutboxBatch({
      db: infra.db,
      outbox: FIXTURE_OUTBOX,
      apply: (row) => {
        if (row.aggregateId === aggregateId) {
          capturedCreatedAt = row.createdAt;
        }
        return Promise.resolve();
      },
    });

    expect(capturedCreatedAt).toBeInstanceOf(Date);
    expect((capturedCreatedAt as Date).getTime()).toBeGreaterThanOrEqual(beforeInsert - 1_000);
    expect((capturedCreatedAt as Date).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('reports oldestPendingAgeMs for a non-empty backlog and undefined for an empty one', async () => {
    const aggregateId = `age-${crypto.randomUUID()}`;
    await infra.db
      .transaction()
      .execute((trx) =>
        insertOutboxRows(trx, FIXTURE_OUTBOX, [{ aggregateId, op: 'test.op', payload: {} }]),
      );
    const withBacklog = await relayOutboxBatch({
      db: infra.db,
      outbox: FIXTURE_OUTBOX,
      apply: () => Promise.resolve(),
    });
    expect(withBacklog.oldestPendingAgeMs).toBeGreaterThanOrEqual(0);

    const empty = await relayOutboxBatch({
      db: infra.db,
      outbox: FIXTURE_OUTBOX,
      apply: () => Promise.resolve(),
    });
    expect(empty.claimed).toBe(0);
    expect(empty.oldestPendingAgeMs).toBeUndefined();
  });
});
