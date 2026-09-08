/**
 * Simulates a second, structurally-identical copy of `NotFoundError` as would arise if
 * `@repo/kernel` were duplicated in the dependency graph (e.g. two versions hoisted
 * differently). Deliberately does NOT extend the real `AppError` from `../../src` — that is
 * exactly the point: it proves `isAppError` detects by brand + shape, not only by `instanceof`.
 */
export class DuplicateNotFoundError extends Error {
  readonly brand = 'AppError' as const;
  readonly code = 'NOT_FOUND' as const;
  readonly httpStatus = 404 as const;
  readonly retryable = false as const;

  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}
