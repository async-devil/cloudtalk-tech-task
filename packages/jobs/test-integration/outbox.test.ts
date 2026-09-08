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

describe('insertOutboxRows / relayOutboxBatch', () => {
  let infra: JobsTestInfra;

  beforeAll(async () => {
    infra = await startJobsTestInfra();
  }, 180_000);

  afterAll(async () => {
    await infra.stop();
  }, 60_000);

  it('poison row parks after maxAttempts while siblings commit each pass (per-row isolation)', async () => {
    const poisonAggregateId = `poison-${crypto.randomUUID()}`;
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
