import { InternalError } from '@repo/kernel';
import { rowAs } from '@repo/persistence';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import type { PipelineTableContract } from '../contract.js';
import { stageResultTableRef } from './table-refs.js';

/**
 * Shared write-ahead read (step 3->4): `{table}_stage_result` keyed by
 * `(instanceId, attemptToken)`. `attemptToken` is `'{stage}'` for a stage
 * (`readStageResult`/`writeStageResult`, `stage.ts`) or `'{stage}:{branchKey}'` for a branch
 * (`runPipelineBranch`, `branch.ts`) — the same sibling table serves both.
 */
export async function readAttemptResult<TResult>(
  db: Kysely<unknown>,
  contract: PipelineTableContract,
  instanceId: string,
  attemptToken: string,
  resultSchema: z.ZodType<TResult>,
): Promise<TResult | undefined> {
  const rowSchema = z.object({ result: resultSchema });
  const found = await sql`
    SELECT result
    FROM ${sql.table(stageResultTableRef(contract))}
    WHERE ${sql.id(contract.instanceIdColumn)} = ${instanceId} AND attempt_token = ${attemptToken}
  `.execute(db);
  const row = found.rows[0];
  return row === undefined ? undefined : rowAs(rowSchema, row).result;
}

/**
 * Shared write-ahead write (step 4->5): `INSERT ... ON CONFLICT
 * (instanceId, attemptToken) DO NOTHING`, then re-read — the row that EXISTS (ours or a
 * concurrent winner's) is the result carried forward. The primary key IS the idempotency
 * mechanism (ADR-0007 step 5): a stored result is never re-billed.
 */
export async function writeAttemptResult<TResult>(
  db: Kysely<unknown>,
  contract: PipelineTableContract,
  instanceId: string,
  attemptToken: string,
  resultSchema: z.ZodType<TResult>,
  result: TResult,
): Promise<TResult> {
  await sql`
    INSERT INTO ${sql.table(stageResultTableRef(contract))}
      (${sql.id(contract.instanceIdColumn)}, attempt_token, result)
    VALUES (${instanceId}, ${attemptToken}, ${JSON.stringify(result)}::jsonb)
    ON CONFLICT (${sql.id(contract.instanceIdColumn)}, attempt_token) DO NOTHING
  `.execute(db);

  const written = await readAttemptResult(db, contract, instanceId, attemptToken, resultSchema);
  if (written === undefined) {
    throw new InternalError(
      `writeAttemptResult: ${contract.pipeline}: no row found for instance "${instanceId}" / attempt token "${attemptToken}" immediately after INSERT ... ON CONFLICT DO NOTHING`,
    );
  }
  return written;
}
