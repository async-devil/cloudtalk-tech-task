import { z } from 'zod';

/**
 * One page shape for every list route (SPEC-0003 "Shape of the contract"): `{ items, nextCursor }`.
 * One shape means the SPA needs exactly one paging component and one page-exhaustion test, instead
 * of a bespoke shape invented per list endpoint.
 *
 * `nextCursor` is the opaque, server-minted continuation token for the next page — `null` exactly
 * when this page was the last one, never an empty string, so a caller can branch on `!== null` and
 * never on `.length`. It is keyset-encoded, not an offset or a page number (TASK-0003): an offset
 * would skip or repeat rows as writes land under a paginating reader. What the cursor actually
 * encodes (which columns, which sort) is a route's own concern — this shape only fixes that it is a
 * `string` the client echoes back verbatim and never constructs, decodes or increments itself.
 *
 * Exported twice: `pageOf` is the call form every route below uses (`pageOf(productSummary)`,
 * `pageOf(reviewSummary)`), matching SPEC-0003's own prose name for it. `cursorPageSchema` is the
 * identical function under this package's `*Schema` naming convention (`sessionBootstrapSchema`,
 * `apiErrorShape`), for anyone searching by that pattern instead.
 */
export function pageOf<TItem>(item: z.ZodType<TItem>) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

export const cursorPageSchema = pageOf;

/** The shape `pageOf(item)` validates, named for a call site that needs the TYPE rather than the
 * schema (e.g. a client-side cache entry). */
export type CursorPage<TItem> = { items: TItem[]; nextCursor: string | null };
