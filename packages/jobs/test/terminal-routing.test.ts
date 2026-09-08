import { ProviderUnavailableError } from '@repo/kernel';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { PipelineTableContract } from '../src/contract.js';
import { performExternalCallWithRouting } from '../src/internal/terminal-routing.js';

const contract: PipelineTableContract = {
  pipeline: 'example',
  schema: 'example_context',
  table: 'item',
  instanceIdColumn: 'item_id',
  stages: ['enrich'],
};

// Retry-classified errors never touch the database (§6.3: "Retry ⇒ rethrow untouched") — a db
// stub that throws on first access proves the Retry branch is a pure passthrough.
const unreachableDb = {
  transaction: () => {
    throw new Error('a Retry-classified throw must never reach the database');
  },
} as unknown as Kysely<unknown>;

describe('performExternalCallWithRouting (spec §6.3 terminal routing)', () => {
  it('returns the result on success without touching the database', async () => {
    const result = await performExternalCallWithRouting(
      unreachableDb,
      contract,
      { instanceId: 'i1', stage: 'enrich', attempts: 1 },
      async () => 'ok',
    );
    expect(result).toBe('ok');
  });

  it('Retry-classified errors rethrow untouched, without writing a dead letter', async () => {
    // ProviderUnavailableError is always retryable (classifyRetry rule 1) — the retry branch.
    const error = new ProviderUnavailableError('temporarily down');
    await expect(
      performExternalCallWithRouting(
        unreachableDb,
        contract,
        { instanceId: 'i1', stage: 'enrich', attempts: 1 },
        () => {
          throw error;
        },
      ),
    ).rejects.toBe(error);
  });
});
