import { ConflictError, InternalError } from '@repo/kernel';

/**
 * The duck-typed shape a Postgres driver error carries for a unique-violation (SQLSTATE `23505`).
 * `constraint` is a REQUIRED property typed `string | undefined`, never `constraint?: string`:
 * under `exactOptionalPropertyTypes`, an optional property is one a caller may OMIT, which matters
 * for a shape something else hands you — this one is built fresh, field by field, by
 * {@link asUniqueViolation} on every call, so there is nothing to omit. The field is always
 * present; its value only says whether the driver itself reported a constraint name.
 */
interface UniqueViolation {
  readonly code: string;
  readonly constraint: string | undefined;
}

/**
 * Narrows `unknown` to {@link UniqueViolation} with no `any`: a `typeof`/`null` check, a cast
 * through `Record<string, unknown>` (never `as any`), then `typeof === 'string'` on each field
 * read through it. Deliberately NOT `error instanceof DatabaseError` — `pg` is not even a
 * dependency of this package, and importing a provider SDK into a capability module would put it
 * outside `apps/*​/src/runtime/**`, breaking this module's ADR-0001 extraction proof. Deliberately
 * NOT message matching either: SQLSTATE and `constraint` are wire-protocol fields the driver sets
 * structurally, never prose a wording change could move (ADR-0008's whole argument against
 * matching on `.message`).
 */
function asUniqueViolation(error: unknown): UniqueViolation | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const candidate = error as Record<string, unknown>;
  if (typeof candidate.code !== 'string') {
    return undefined;
  }
  const constraint = typeof candidate.constraint === 'string' ? candidate.constraint : undefined;
  return { code: candidate.code, constraint };
}

/**
 * The unique constraints this module's writes can actually collide with, named rather than spelled
 * as literals at a call site: a pipeline that must branch on WHICH constraint fired (see
 * `submitReview`'s step 6) needs the name, and a name typed here is one the compiler keeps in step
 * with {@link CONFLICT_FIELD_BY_CONSTRAINT}.
 */
export const UNIQUE_CONSTRAINT = {
  ProductSlug: 'uq_product__slug',
  ProductSku: 'uq_product__sku',
  ReviewAuthorPerProduct: 'uq_review__product_id__author_id',
} as const;
export type UniqueConstraintName = (typeof UNIQUE_CONSTRAINT)[keyof typeof UNIQUE_CONSTRAINT];

/**
 * `reviews.product`/`reviews.review`'s unique constraints, mapped to the wire-safe field a caller
 * can act on. Anything NOT listed here — `uq_review__token` included — is deliberately absent;
 * see {@link translateUniqueViolation}'s doc for why.
 */
const CONFLICT_FIELD_BY_CONSTRAINT: Readonly<Record<UniqueConstraintName, string>> = {
  [UNIQUE_CONSTRAINT.ProductSlug]: 'slug',
  [UNIQUE_CONSTRAINT.ProductSku]: 'sku',
  [UNIQUE_CONSTRAINT.ReviewAuthorPerProduct]: 'review',
};

/**
 * Whether a driver-reported constraint name is one this module maps to a caller-actionable field.
 * A type guard rather than a bare lookup so {@link CONFLICT_FIELD_BY_CONSTRAINT} can stay keyed by
 * {@link UniqueConstraintName}: that keying is what makes adding a constraint to
 * {@link UNIQUE_CONSTRAINT} without giving it a field a compile error rather than a silent
 * `undefined` at runtime.
 */
function isMappedConstraint(name: string): name is UniqueConstraintName {
  return Object.values(UNIQUE_CONSTRAINT).some((known) => known === name);
}

/**
 * The constraint name a `23505` reported, or `undefined` for any other error (and for a `23505`
 * the driver did not name a constraint on). Exists so a caller can branch on WHICH constraint
 * fired before deciding what the failure means: `submitReview` treats
 * {@link UNIQUE_CONSTRAINT.ReviewAuthorPerProduct} as "re-read and decide replay vs conflict",
 * and every other unique violation as the failure {@link translateUniqueViolation} classifies it
 * as. Collapsing the two would answer a token collision — this module's own minting colliding
 * with itself — with a message about a review the caller raced, which is not what happened.
 */
export function uniqueViolationConstraintOf(error: unknown): string | undefined {
  const violation = asUniqueViolation(error);
  if (violation === undefined || violation.code !== '23505') {
    return undefined;
  }
  return violation.constraint;
}

/**
 * Maps a Postgres unique-violation to a typed `AppError` — the repository's FIRST `23505`
 * translator, so the argument for this shape lives here rather than being assumed at whichever
 * call site reaches for it next.
 *
 * - `uq_product__slug` -> `ConflictError`, `details.field: 'slug'`.
 * - `uq_product__sku` -> `ConflictError`, `details.field: 'sku'`.
 * - `uq_review__product_id__author_id` -> `ConflictError`, `details.field: 'review'`.
 * - ANY OTHER `23505`, `uq_review__token` included, -> `InternalError`. Deliberately NOT a
 *   `ConflictError` (this module's ruling): a token collision is this module's OWN minting
 *   colliding with itself, never anything the caller sent — a 409 would tell a user to change a
 *   request field they never supplied.
 * - Not a `23505` at all (wrong SQLSTATE, or no `code` field at all) -> `undefined`, so the
 *   caller rethrows the original error unchanged.
 */
export function translateUniqueViolation(
  error: unknown,
): ConflictError | InternalError | undefined {
  const violation = asUniqueViolation(error);
  if (violation === undefined || violation.code !== '23505') {
    return undefined;
  }

  const field =
    violation.constraint !== undefined && isMappedConstraint(violation.constraint)
      ? CONFLICT_FIELD_BY_CONSTRAINT[violation.constraint]
      : undefined;
  if (field !== undefined) {
    return new ConflictError(`unique constraint violated on "${field}"`, {
      cause: error,
      details: { field },
    });
  }

  return new InternalError('unique constraint violated on an internally-minted value', {
    cause: error,
    ...(violation.constraint !== undefined
      ? { details: { constraint: violation.constraint } }
      : {}),
  });
}
