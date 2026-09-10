import { ValidationError } from '@repo/kernel';
import type { z } from 'zod';

/**
 * The opaque-cursor codec `listProducts`/`listReviewsForProduct` share (TASK-0003, SPEC-0003's
 * `pageOf` doc): base64url of a small JSON payload. "Opaque" means a caller only ever echoes it
 * back verbatim — never a page number, never decoded or constructed outside this module. What the
 * payload actually holds (which sort, which columns) is each call site's own concern; this file
 * only fixes the encode/decode mechanics and the one failure mode both share: a cursor that fails
 * to decode, or decodes to something that fails the caller's own schema, is a `ValidationError`
 * with `details.field: 'cursor'` — the same code an out-of-range `limit` gets (SPEC-0003), never a
 * 500 and never a silently-ignored parameter.
 */
export function encodeCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** @throws ValidationError when `cursor` is not valid base64url JSON matching `schema`. */
export function decodeCursor<T>(cursor: string, schema: z.ZodType<T>): T {
  const cursorError = () =>
    new ValidationError('cursor is not a valid continuation token', {
      details: { field: 'cursor' },
    });

  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw cursorError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw cursorError();
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw cursorError();
  }
  return result.data;
}
