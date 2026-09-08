import { ValidationError } from '@repo/kernel';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { PipelineTableContract } from '../src/contract.js';
import { purgeDeadLetters, purgePipelineData, startRetention } from '../src/retention.js';

const contract: PipelineTableContract = {
  pipeline: 'example',
  schema: 'example_context',
  table: 'item',
  instanceIdColumn: 'item_id',
  stages: ['enrich'],
};

// Never reached: every case here throws before the first statement touches the database
// (ADR-0006 — "at the START, before touching the database"). Any property access beyond
// `.transaction` throwing proves the floor check ran first, not the DB round trip.
const unreachableDb = {
  transaction: () => {
    throw new Error('retention validation must throw before opening a transaction');
  },
} as unknown as Kysely<unknown>;

describe('purgePipelineData / startRetention: the ADR-0006 floor', () => {
  it('throws ValidationError when stageResultRetainMs <= staleAfterMs', async () => {
    await expect(
      purgePipelineData({
        db: unreachableDb,
        contract,
        stageResultRetainMs: 1_000,
        staleAfterMs: 1_000,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when an outbox horizon is missing', async () => {
    await expect(
      purgePipelineData({
        db: unreachableDb,
        contract,
        outbox: { schema: 'example_context', table: 'outbox' },
        stageResultRetainMs: 60_000,
        staleAfterMs: 1_000,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when an outbox horizon does not exceed staleAfterMs', async () => {
    await expect(
      purgePipelineData({
        db: unreachableDb,
        contract,
        outbox: { schema: 'example_context', table: 'outbox' },
        stageResultRetainMs: 60_000,
        processedOutboxRetainMs: 500,
        deadOutboxRetainMs: 60_000,
        staleAfterMs: 1_000,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('startRetention rejects before ever scheduling (connection/everyMs never used)', async () => {
    await expect(
      startRetention({
        db: unreachableDb,
        contract,
        stageResultRetainMs: 1_000,
        staleAfterMs: 1_000,
        connection: { redisUrl: 'redis://unused' },
        everyMs: 60_000,
      }),
    ).rejects.toThrow(ValidationError);
  });
});

describe('purgeDeadLetters: the same floor, jobs-owned', () => {
  it('throws ValidationError when retainMs <= staleAfterMs', async () => {
    await expect(
      purgeDeadLetters({
        db: unreachableDb,
        pipeline: 'example',
        retainMs: 1_000,
        staleAfterMs: 1_000,
      }),
    ).rejects.toThrow(ValidationError);
  });
});
