import { isAppError, ValidationError } from '@repo/kernel';
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

  // INV-1 (single-row half)
  it('throws kernel ValidationError with issue paths on a non-conforming row', () => {
    let caught: unknown;
    try {
      rowAs(rowSchema, { id: 'a', count: 'not-a-number' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(isAppError(caught)).toBe(true);
    const details = (caught as ValidationError).details as {
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
  it('throws kernel ValidationError naming the offending row index', () => {
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
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).toContain('index 1');
    expect((caught as ValidationError).details).toMatchObject({ rowIndex: 1 });
  });
});
