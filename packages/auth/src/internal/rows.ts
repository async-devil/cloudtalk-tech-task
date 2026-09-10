import { z } from 'zod';

/** The `auth.app_user` shape the session middleware reads. Raw SQL rows parse through `rowAs` at
 * this boundary rather than being cast (ADR-0004, ADR-0006) — a cast is a claim, a parse is a
 * check. `catalogue_manager` (TASK-0008, ADR-0018) and `moderator` (TASK-0009, ADR-0018) join
 * `app_user_id`/`token` here rather than a second query each: `resolveRequestSession` resolves
 * both capabilities the same request it resolves identity, so a capability-gated router never
 * needs a round trip beyond the one every route already pays for session resolution. */
export const appUserRowSchema = z.object({
  app_user_id: z.string(),
  token: z.string(),
  catalogue_manager: z.boolean(),
  moderator: z.boolean(),
});
export type AppUserRow = z.infer<typeof appUserRowSchema>;

/**
 * `auth.app_user` JOINed to `auth.identity` — `author-label.ts`'s one read. `email` never leaves
 * this row: {@link deriveAuthorLabel} consumes it and only the derived label is ever returned to a
 * caller (SPEC-0001 open question 1). Never logged, never a span/metric attribute — this module's
 * own redaction discipline for `email` (see `internal/observability.ts`'s header) applies here as
 * much as anywhere else in this package.
 */
export const authorEmailRowSchema = z.object({
  app_user_id: z.string(),
  email: z.string(),
});
export type AuthorEmailRow = z.infer<typeof authorEmailRowSchema>;
