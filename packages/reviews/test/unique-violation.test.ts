import { ConflictError, InternalError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';
import {
  translateUniqueViolation,
  UNIQUE_CONSTRAINT,
  uniqueViolationConstraintOf,
} from '../src/internal/unique-violation.js';

/** Builds a driver-shaped error: a plain `Error` carrying `code`/`constraint` as own properties —
 * exactly the duck-typed shape `pg` attaches to a real unique-violation, with no `pg` dependency
 * needed to construct one. */
function driverError(code: string, constraint?: string): unknown {
  const error = new Error('duplicate key value violates unique constraint');
  return Object.assign(error, { code, ...(constraint !== undefined ? { constraint } : {}) });
}

describe('translateUniqueViolation', () => {
  it('maps uq_product__slug to a ConflictError on "slug"', () => {
    const error = translateUniqueViolation(driverError('23505', 'uq_product__slug'));
    expect(error).toBeInstanceOf(ConflictError);
    expect(error?.details).toEqual({ field: 'slug' });
  });

  it('maps uq_product__sku to a ConflictError on "sku"', () => {
    const error = translateUniqueViolation(driverError('23505', 'uq_product__sku'));
    expect(error).toBeInstanceOf(ConflictError);
    expect(error?.details).toEqual({ field: 'sku' });
  });

  it('maps uq_review__product_id__author_id to a ConflictError on "review"', () => {
    const error = translateUniqueViolation(
      driverError('23505', 'uq_review__product_id__author_id'),
    );
    expect(error).toBeInstanceOf(ConflictError);
    expect(error?.details).toEqual({ field: 'review' });
  });

  it('maps uq_review__token — our own minted collision — to InternalError, never ConflictError', () => {
    const error = translateUniqueViolation(driverError('23505', 'uq_review__token'));
    expect(error).toBeInstanceOf(InternalError);
  });

  it('maps any other unlisted 23505 constraint to InternalError', () => {
    const error = translateUniqueViolation(driverError('23505', 'uq_something__unlisted'));
    expect(error).toBeInstanceOf(InternalError);
  });

  it('returns undefined for a non-23505 driver error (e.g. a foreign-key violation)', () => {
    expect(translateUniqueViolation(driverError('23503', 'fk_review__product'))).toBeUndefined();
  });

  it('returns undefined for a value with no driver code at all', () => {
    expect(translateUniqueViolation(new Error('boom'))).toBeUndefined();
    expect(translateUniqueViolation('boom')).toBeUndefined();
    expect(translateUniqueViolation(undefined)).toBeUndefined();
  });

  // The no-message-matching proof (ADR-0008): a plain Error carrying the REAL driver wording as
  // its `.message`, but with no SQLSTATE `code` at all, must NOT translate. A translator that
  // matched on `error.message` instead of `error.code` would wrongly turn this into a
  // ConflictError. This fixture is what goes red under that mutation — see the module README's
  // "mutation observed" note for the exact result of running it.
  it('does not translate a plain Error whose message merely reads like a unique violation', () => {
    const messageOnly = new Error(
      'duplicate key value violates unique constraint "uq_product__slug"',
    );
    expect(translateUniqueViolation(messageOnly)).toBeUndefined();
  });
});

describe('uniqueViolationConstraintOf', () => {
  // `submitReview`'s step-6 catch branches on this rather than on "was it a unique violation at
  // all": only the one-review-per-author constraint means an existing review is there to be read
  // back. A token collision routed down that path would find no row and answer with a message
  // about a review the caller raced, which is not what happened.
  it('names the constraint a 23505 reported', () => {
    expect(
      uniqueViolationConstraintOf(driverError('23505', 'uq_review__product_id__author_id')),
    ).toBe(UNIQUE_CONSTRAINT.ReviewAuthorPerProduct);
    expect(uniqueViolationConstraintOf(driverError('23505', 'uq_review__token'))).toBe(
      'uq_review__token',
    );
  });

  it('distinguishes the author-per-product collision from every other unique violation', () => {
    expect(uniqueViolationConstraintOf(driverError('23505', 'uq_review__token'))).not.toBe(
      UNIQUE_CONSTRAINT.ReviewAuthorPerProduct,
    );
  });

  it('returns undefined for a non-23505 error, an unnamed 23505, and a non-object', () => {
    expect(uniqueViolationConstraintOf(driverError('23503', 'fk_review__product'))).toBeUndefined();
    expect(uniqueViolationConstraintOf(driverError('23505'))).toBeUndefined();
    expect(uniqueViolationConstraintOf(new Error('duplicate key value'))).toBeUndefined();
    expect(uniqueViolationConstraintOf(null)).toBeUndefined();
  });
});
