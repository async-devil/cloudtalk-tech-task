import { classifyRetry, RETRY_DECISION } from '@repo/kernel';
import type { Kysely } from 'kysely';
import type { PipelineTableContract } from '../contract.js';
import { type DeadLetterRecord, writeDeadLetter } from '../dead-letter.js';

/**
 * terminal routing, frozen — realized INSIDE `runPipelineStage`/`runPipelineBranch` rather
 * than a detachable wrapper (a separable wrapper would let a worker adopt the spine without
 * ADR-0007's ceiling): runs `performExternalCall`; on throw, `classifyRetry(error)` — `Terminal`
 * writes the dead letter (reason = the classification reason, attempts = the current state-row
 * attempts the caller already knows from its claim) then rethrows the ORIGINAL error so the
 * messaging boundary classifies it again, logs once via `failSpan`, and marks
 * the queue job unrecoverable — no double logging, `writeDeadLetter`'s log is the DLQ-row record
 * (module `jobs`), the worker's is the job-boundary record (module `messaging`), different
 * boundaries, each fires once (ADR-0008). `Retry` rethrows untouched — BullMQ backoff owns the
 * short game, the claim-time ceiling and the reconciler own the long game.
 */
export async function performExternalCallWithRouting<TResult>(
  db: Kysely<unknown>,
  contract: PipelineTableContract,
  record: Omit<DeadLetterRecord, 'reason'>,
  performExternalCall: () => Promise<TResult>,
): Promise<TResult> {
  try {
    return await performExternalCall();
  } catch (error) {
    const classification = classifyRetry(error);
    if (classification.decision === RETRY_DECISION.Terminal) {
      await writeDeadLetter(db, contract, { ...record, reason: classification.reason });
    }
    throw error;
  }
}
