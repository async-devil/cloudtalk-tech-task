import { describe, expect, it } from 'vitest';
import { AppError, isAppError } from '../src/index.js';
import { DuplicateNotFoundError } from './fixtures/duplicate-not-found-error.js';

describe('isAppError cross-copy detection (INV-4)', () => {
  it('recognizes an AppError-shaped value built from a different class copy', () => {
    const duplicate = new DuplicateNotFoundError('not found elsewhere');

    // Confirms the premise: this is NOT `instanceof` the real AppError.
    expect(duplicate instanceof AppError).toBe(false);
    expect(isAppError(duplicate)).toBe(true);
  });

  it('rejects a lookalike missing the brand field', () => {
    const lookalike = { code: 'NOT_FOUND', httpStatus: 404, retryable: false };
    expect(isAppError(lookalike)).toBe(false);
  });

  it('rejects a lookalike with the brand but wrong field types', () => {
    const lookalike = { brand: 'AppError', code: 'NOT_FOUND', httpStatus: '404', retryable: false };
    expect(isAppError(lookalike)).toBe(false);
  });
});
