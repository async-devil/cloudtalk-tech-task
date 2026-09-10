import { rowsAs } from '@repo/persistence';
import { type Kysely, sql } from 'kysely';
import { observability } from './internal/observability.js';
import { authorEmailRowSchema } from './internal/rows.js';

/** SPEC-0001 open question 1's fallback: the literal string a caller reads when nothing is left
 * to show after trimming the local part — never an empty string. */
const AUTHOR_LABEL_FALLBACK = 'Reviewer';

/** SPEC-0001 open question 1: "24 characters is comfortably longer than a typical local part and
 * short enough that a review card's byline never wraps." Taken verbatim, no ellipsis — a label is
 * a fixed display value, not a preview of something longer. */
const AUTHOR_LABEL_MAX_LENGTH = 24;

/**
 * `authorLabel`'s exact derivation (SPEC-0001 open question 1, resolved; SPEC-0003
 * `reviewSummary.authorLabel`): the LOCAL PART of `email` — the substring before the first `@` —
 * trimmed, then truncated to at most {@link AUTHOR_LABEL_MAX_LENGTH} characters, falling back to
 * {@link AUTHOR_LABEL_FALLBACK} when nothing is left after trimming.
 *
 * A PURE function of the stored email, so the same author always renders the same label — and the
 * one function in this package that ever touches an email string end to end, which is also why it
 * is the one place that could leak it and the one place proven not to (`test/author-label.test.ts`
 * asserts the fallback and truncation boundaries, not merely the happy path). **The email itself
 * never crosses this function's return value in any form** — only the derived label does.
 */
export function deriveAuthorLabel(email: string): string {
  const atIndex = email.indexOf('@');
  const localPart = (atIndex === -1 ? email : email.slice(0, atIndex)).trim();
  if (localPart.length === 0) {
    return AUTHOR_LABEL_FALLBACK;
  }
  return localPart.slice(0, AUTHOR_LABEL_MAX_LENGTH);
}

/**
 * Resolves `authorLabel` for a batch of `auth.app_user.app_user_id` values in one round trip —
 * the composition-root seam TASK-0003 asks for: `@repo/reviews` cannot query `auth.identity`
 * itself (no sanctioned Tier-2 edge, `tools/arch-checks/src/module-registry.cjs`), so a review
 * list's router joins a review's `authorId` (from `@repo/reviews`) against this function's Map
 * instead of either module reaching into the other's schema.
 *
 * Returns a `Map` rather than an array so a caller can look up by id directly; an id with no
 * matching row (schema drift — `auth.app_user`/`auth.identity` are both `NOT NULL`-linked by
 * foreign key, so this should not happen in practice) is simply absent from the map rather than
 * silently defaulting, so a caller notices instead of rendering a wrong label. Deduplicates
 * `userIds` before querying: a review list's authors repeat far more than they don't.
 */
export function authorLabelsForUserIds(
  db: Kysely<unknown>,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  return observability.withSpan('auth.author.label', async () => {
    const uniqueIds = [...new Set(userIds)];
    if (uniqueIds.length === 0) {
      return new Map<string, string>();
    }
    const result = await sql`
      SELECT au.app_user_id, ai.email
      FROM auth.app_user au
      JOIN auth.identity ai ON ai.id = au.identity_id
      WHERE au.app_user_id IN (${sql.join(uniqueIds)})
    `.execute(db);
    const rows = rowsAs(authorEmailRowSchema, result.rows);
    return new Map(rows.map((row) => [row.app_user_id, deriveAuthorLabel(row.email)]));
  });
}
