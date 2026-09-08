import { z } from 'zod';

/**
 * The branch-drive-mechanism vocabulary (ADR-0006) — seeded into `reference.branch_kind` by
 * `packages/persistence/migrations/0002-create-jobs-spine.ts` and pinned by
 * `packages/jobs/test-integration/reference-parity.test.ts`. See {@link STAGE_STATUS}
 * (`stage-status.entity.ts`) for why the `{ id, name }` record shape is frozen rather than a bare
 * `name -> id` map.
 */
export const BRANCH_KIND = {
  /** Driven by our own queue job — the reconciler redrives it (remove-then-re-add). */
  Owned: { id: 1, name: 'owned' },
  /** Completed by an external actor (webhook/callback) — nothing to redrive; the reconciler AGES
   * it (attempts++ per stale scan) toward the same uniform ceiling (ADR-0003). */
  Delegated: { id: 2, name: 'delegated' },
} as const;
export type BranchKindId = (typeof BRANCH_KIND)[keyof typeof BRANCH_KIND]['id'];
export type BranchKindName = (typeof BRANCH_KIND)[keyof typeof BRANCH_KIND]['name'];

/** The `reference.branch_kind` row shape (ADR-0004 raw-SQL parse boundary). */
export const branchKindRowSchema = z.object({
  branch_kind_id: z.number().int(),
  name: z.string(),
});
export type BranchKindRow = z.infer<typeof branchKindRowSchema>;
