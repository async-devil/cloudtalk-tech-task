import { ValidationError } from '@repo/kernel';
import type { z } from 'zod';

/**
 * Parses one raw row (typically from the typed `sql` template) through a Zod row schema —
 * the raw-SQL edge is a parse boundary (ADR-0004; closes the `as unknown as` cast hole).
 * @throws ValidationError when the row does not match the schema.
 */
export function rowAs<T>(schema: z.ZodType<T>, row: unknown): T {
  const result = schema.safeParse(row);
  if (!result.success) {
    throw new ValidationError('rowAs: row failed schema parse', {
      details: { issues: issuesFrom(result.error) },
    });
  }
  return result.data;
}

/**
 * Parses an array of raw rows through a Zod row schema (ADR-0004).
 * @throws ValidationError naming the offending row index on the first parse failure.
 */
export function rowsAs<T>(schema: z.ZodType<T>, rows: ReadonlyArray<unknown>): T[] {
  return rows.map((row, index) => {
    const result = schema.safeParse(row);
    if (!result.success) {
      throw new ValidationError(`rowsAs: row at index ${index} failed schema parse`, {
        details: { rowIndex: index, issues: issuesFrom(result.error) },
      });
    }
    return result.data;
  });
}

/** Safe-for-wire issue summary (paths + messages only, never row values — ADR-0004 details). */
function issuesFrom(error: z.ZodError): Array<{ readonly path: string; readonly message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}
