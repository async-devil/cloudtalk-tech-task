import type { JsonValue } from '@repo/kernel';
import { z } from 'zod';

// Every dynamic ({stage}-prefixed) column this package reads is aliased to a fixed name in the
// `SELECT` itself (e.g. `SELECT {stage}_attempts AS attempts`), so the Zod row schemas below can
// stay static instead of being rebuilt per stage/pipeline (ADR-0004: raw rows parse through
// `rowsAs`/`rowAs`; a schema keyed by a runtime-computed column name would defeat the point).

export const stageStatusIdRowSchema = z.object({ stage_status_id: z.number().int() });
// `is_stale` is computed in the SELECT (the same `updated_at < now() - interval` predicate the
// reconciler's stale scan uses) rather than derived in TS from a timestamp: staleness must be
// judged by the database clock that wrote `updated_at`, and comparing it under the row's advisory
// lock is what makes the reconciler's re-check meaningful.
export const stageAttemptsRowSchema = z.object({
  stage_status_id: z.number().int(),
  attempts: z.number().int(),
  is_stale: z.boolean(),
});
export const attemptsRowSchema = z.object({ attempts: z.number().int() });
export const branchStatusIdRowSchema = z.object({ branch_status_id: z.number().int() });
export const branchAttemptsRowSchema = z.object({
  branch_status_id: z.number().int(),
  attempts: z.number().int(),
  is_stale: z.boolean(),
});
export const branchKeyRowSchema = z.object({ instance_id: z.string(), branch_key: z.string() });
export const instanceIdRowSchema = z.object({ instance_id: z.string() });
export const openCountRowSchema = z.object({ open_count: z.number().int() });
export const oldestCreatedAtRowSchema = z.object({ created_at: z.date() });

/** Recursive JSON value schema (ADR-0004) — used for `jsonb` columns the spine reads back that
 * are not the caller's own `TResult`/domain shape (dead-letter/outbox payloads). */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
