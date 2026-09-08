import { z } from 'zod';

/**
 * The pipeline-stage lifecycle vocabulary (ADR-0006) — the single source `reference.stage_status`
 * is seeded from (`packages/persistence/migrations/0002-create-jobs-spine.ts`) and
 * `packages/jobs/test-integration/reference-parity.test.ts` pins. The `{ id, name }` record shape
 * is frozen: it mirrors the reference table's two columns exactly, so a parity test never needs a
 * transformation between this const object and `SELECT * FROM reference.stage_status` — a
 * transformation is where drift hides. Ids are the contract — they appear in every FK and
 * `DEFAULT` clause on every pipeline instance table — and are never renumbered.
 */
export const STAGE_STATUS = {
  Pending: { id: 1, name: 'pending' },
  InProgress: { id: 2, name: 'in_progress' },
  Completed: { id: 3, name: 'completed' },
  /** Terminal: a dead-letter row exists. Review states are a MODULE concern layered on its own
   * columns — the spine's vocabulary is closed at these four. */
  Failed: { id: 4, name: 'failed' },
} as const;
export type StageStatusId = (typeof STAGE_STATUS)[keyof typeof STAGE_STATUS]['id'];
export type StageStatusName = (typeof STAGE_STATUS)[keyof typeof STAGE_STATUS]['name'];

/** The `reference.stage_status` row shape (ADR-0004 raw-SQL parse boundary) — used by the parity
 * proof and by any code reading the vocabulary back from Postgres. */
export const stageStatusRowSchema = z.object({
  stage_status_id: z.number().int(),
  name: z.string(),
});
export type StageStatusRow = z.infer<typeof stageStatusRowSchema>;
