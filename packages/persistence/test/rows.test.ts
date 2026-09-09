import { InternalError, isAppError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { rowAs, rowsAs } from '../src/index.js';

const rowSchema = z.object({
  id: z.string(),
  count: z.number(),
});

describe('rowAs', () => {
  it('parses a conforming row and returns the typed value', () => {
    const row = rowAs(rowSchema, { id: 'a', count: 1 });
    expect(row).toEqual({ id: 'a', count: 1 });
  });

  it('strips unknown keys (Zod object default) so raw rows stay schema-shaped', () => {
    const row = rowAs(rowSchema, { id: 'a', count: 1, extra: 'dropped' });
    expect(row).toEqual({ id: 'a', count: 1 });
  });

  // INV-1 (single-row half). Schema drift is a SERVER fault: the 500/non-retryable classification
  // is the assertion here, not an implementation detail — as a `ValidationError` this same row
  // reached the caller as a 400 carrying the offending column paths.
  it('throws kernel InternalError (500, terminal) with issue paths on a non-conforming row', () => {
    let caught: unknown;
    try {
      rowAs(rowSchema, { id: 'a', count: 'not-a-number' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InternalError);
    expect(isAppError(caught)).toBe(true);
    expect((caught as InternalError).httpStatus).toBe(500);
    expect((caught as InternalError).retryable).toBe(false);
    const details = (caught as InternalError).details as {
      issues: Array<{ path: string; message: string }>;
    };
    expect(details.issues.some((issue) => issue.path === 'count')).toBe(true);
  });
});

describe('rowsAs', () => {
  it('parses a conforming array and preserves order', () => {
    const rows = rowsAs(rowSchema, [
      { id: 'a', count: 1 },
      { id: 'b', count: 2 },
    ]);
    expect(rows).toEqual([
      { id: 'a', count: 1 },
      { id: 'b', count: 2 },
    ]);
  });

  it('returns an empty array for no rows', () => {
    expect(rowsAs(rowSchema, [])).toEqual([]);
  });

  // INV-1
  it('throws kernel InternalError naming the offending row index', () => {
    let caught: unknown;
    try {
      rowsAs(rowSchema, [
        { id: 'a', count: 1 },
        { id: 'b', count: 'broken' },
        { id: 'c', count: 3 },
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InternalError);
    expect((caught as InternalError).message).toContain('index 1');
    expect((caught as InternalError).details).toMatchObject({ rowIndex: 1 });
  });
});
