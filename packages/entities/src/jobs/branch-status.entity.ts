import { z } from 'zod';

/**
 * The fan-out branch lifecycle vocabulary (ADR-0006) — seeded into `reference.branch_status` by
 * `packages/persistence/migrations/0002-create-jobs-spine.ts` and pinned by
 * `packages/jobs/test-integration/reference-parity.test.ts`. See {@link STAGE_STATUS}
 * (`stage-status.entity.ts`) for why the `{ id, name }` record shape is frozen rather than a bare
 * `name -> id` map.
 */
export const BRANCH_STATUS = {
  Pending: { id: 1, name: 'pending' },
  Completed: { id: 2, name: 'completed' },
  Failed: { id: 3, name: 'failed' },
} as const;
export type BranchStatusId = (typeof BRANCH_STATUS)[keyof typeof BRANCH_STATUS]['id'];
export type BranchStatusName = (typeof BRANCH_STATUS)[keyof typeof BRANCH_STATUS]['name'];

/** The `reference.branch_status` row shape (ADR-0004 raw-SQL parse boundary). */
export const branchStatusRowSchema = z.object({
  branch_status_id: z.number().int(),
  name: z.string(),
});
export type BranchStatusRow = z.infer<typeof branchStatusRowSchema>;
