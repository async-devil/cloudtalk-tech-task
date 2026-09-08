import { z } from 'zod';

/**
 * The outbox-row lifecycle vocabulary (ADR-0006) — seeded into `reference.outbox_row_status` by
 * `packages/persistence/migrations/0002-create-jobs-spine.ts` and pinned by
 * `packages/jobs/test-integration/reference-parity.test.ts`. `Processed` replaces the old
 * dual-source `processed_at IS NOT NULL` reading (ADR-0006: the status column is truth, the
 * timestamp is evidence). See {@link STAGE_STATUS} (`stage-status.entity.ts`) for why the
 * `{ id, name }` record shape is frozen.
 */
export const OUTBOX_ROW_STATUS = {
  Pending: { id: 1, name: 'pending' },
  Processed: { id: 2, name: 'processed' },
  Dead: { id: 3, name: 'dead' },
} as const;
export type OutboxRowStatusId = (typeof OUTBOX_ROW_STATUS)[keyof typeof OUTBOX_ROW_STATUS]['id'];
export type OutboxRowStatusName =
  (typeof OUTBOX_ROW_STATUS)[keyof typeof OUTBOX_ROW_STATUS]['name'];

/** The `reference.outbox_row_status` row shape (ADR-0004 raw-SQL parse boundary). */
export const outboxRowStatusRowSchema = z.object({
  outbox_row_status_id: z.number().int(),
  name: z.string(),
});
export type OutboxRowStatusRow = z.infer<typeof outboxRowStatusRowSchema>;
