import { InternalError } from '@repo/kernel';
import type { z } from 'zod';

/**
 * Parses one raw row (typically from the typed `sql` template) through a Zod row schema —
 * the raw-SQL edge is a parse boundary (ADR-0004; closes the `as unknown as` cast hole).
 *
 * The failure is an `InternalError`, NOT a `ValidationError` (review, 2026-09-09). A row that does
 * not match its schema is schema drift — a migration that landed without its reader, a column
 * retyped underneath a query — never anything the caller sent. Classifying it as validation mapped
 * it to a 400 at the HTTP boundary, which told the caller to fix a request that was fine and put
 * internal column paths in a body that keeps its `details`. As a 5xx it reads as what it is: our
 * own data-integrity fault, generic on the wire (the boundary drops `details` for a server fault),
 * with the issue paths still on the error for the log and the span.
 *
 * Non-retryable: replaying the same query against the same schema fails identically.
 * @throws InternalError when the row does not match the schema.
 */
export function rowAs<T>(schema: z.ZodType<T>, row: unknown): T {
  const result = schema.safeParse(row);
  if (!result.success) {
    throw new InternalError('rowAs: row failed schema parse', {
      details: { issues: issuesFrom(result.error) },
    });
  }
  return result.data;
}

/**
 * Parses an array of raw rows through a Zod row schema (ADR-0004).
 * @throws InternalError (see {@link rowAs} for why it is not a `ValidationError`) naming the
 * offending row index on the first parse failure.
 */
export function rowsAs<T>(schema: z.ZodType<T>, rows: ReadonlyArray<unknown>): T[] {
  return rows.map((row, index) => {
    const result = schema.safeParse(row);
    if (!result.success) {
      throw new InternalError(`rowsAs: row at index ${index} failed schema parse`, {
        details: { rowIndex: index, issues: issuesFrom(result.error) },
      });
    }
    return result.data;
  });
}

/** Issue summary carried on the error's `details` (paths + messages only, never row values —
 * ADR-0004). Internal by classification, so it reaches logs and spans but not a 5xx body. */
function issuesFrom(error: z.ZodError): Array<{ readonly path: string; readonly message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}
