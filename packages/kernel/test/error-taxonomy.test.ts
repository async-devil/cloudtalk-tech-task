import { describe, expect, it } from 'vitest';
import {
  AppError,
  ConflictError,
  type ErrorCode,
  ForbiddenError,
  InternalError,
  isAppError,
  NotFoundError,
  ProviderError,
  ProviderUnavailableError,
  RateLimitedError,
  UnauthorizedError,
  ValidationError,
} from '../src/index.js';

interface FixedShapeCase {
  readonly name: string;
  readonly Ctor: new (message: string) => AppError;
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
}

// INV-1: every subclass fixes its code/httpStatus/retryable at the definition site.
const fixedShapeCases: readonly FixedShapeCase[] = [
  {
    name: 'ValidationError',
    Ctor: ValidationError,
    code: 'VALIDATION',
    httpStatus: 400,
    retryable: false,
  },
  {
    name: 'UnauthorizedError',
    Ctor: UnauthorizedError,
    code: 'UNAUTHORIZED',
    httpStatus: 401,
    retryable: false,
  },
  {
    name: 'ForbiddenError',
    Ctor: ForbiddenError,
    code: 'FORBIDDEN',
    httpStatus: 403,
    retryable: false,
  },
  {
    name: 'NotFoundError',
    Ctor: NotFoundError,
    code: 'NOT_FOUND',
    httpStatus: 404,
    retryable: false,
  },
  {
    name: 'ConflictError',
    Ctor: ConflictError,
    code: 'CONFLICT',
    httpStatus: 409,
    retryable: false,
  },
  {
    name: 'RateLimitedError',
    Ctor: RateLimitedError,
    code: 'RATE_LIMITED',
    httpStatus: 429,
    retryable: true,
  },
];

describe('kernel error taxonomy shape', () => {
  describe.each(fixedShapeCases)('$name', ({ Ctor, code, httpStatus, retryable }) => {
    it('fixes code/httpStatus/retryable and is detected by isAppError (INV-1)', () => {
      const err = new Ctor('boom');
      expect(err.code).toBe(code);
      expect(err.httpStatus).toBe(httpStatus);
      expect(err.retryable).toBe(retryable);
      expect(err.brand).toBe('AppError');
      expect(err).toBeInstanceOf(AppError);
      expect(err).toBeInstanceOf(Error);
      expect(isAppError(err)).toBe(true);
    });
  });

  it('ProviderError defaults retryable to false and accepts an override (INV-2)', () => {
    const terminal = new ProviderError('down');
    expect(terminal.code).toBe('PROVIDER');
    expect(terminal.httpStatus).toBe(502);
    expect(terminal.retryable).toBe(false);

    const retryable = new ProviderError('down (retryable)', { retryable: true });
    expect(retryable.retryable).toBe(true);
  });

  it('InternalError defaults retryable to false and accepts an override (INV-2)', () => {
    const terminal = new InternalError('oops');
    expect(terminal.code).toBe('INTERNAL');
    expect(terminal.httpStatus).toBe(500);
    expect(terminal.retryable).toBe(false);

    const retryable = new InternalError('oops (retryable)', { retryable: true });
    expect(retryable.retryable).toBe(true);
  });

  it('ProviderUnavailableError fixes code PROVIDER/503/retryable=true and accepts no override', () => {
    const err = new ProviderUnavailableError('down (transient)');
    expect(err.code).toBe('PROVIDER');
    expect(err.httpStatus).toBe(503);
    expect(err.retryable).toBe(true);
    expect(err).toBeInstanceOf(ProviderError);
    expect(isAppError(err)).toBe(true);

    // The constructor accepts AppErrorOptions (details/cause) but no retryable override — the
    // frozen constraint is that retryable is fixed true regardless of what a caller passes through
    // an options bag not typed to accept it. `details`/`cause` still carry through normally.
    const cause = new Error('root cause');
    const withOptions = new ProviderUnavailableError('down', {
      details: { provider: 'stripe' },
      cause,
    });
    expect(withOptions.retryable).toBe(true);
    expect(withOptions.details).toEqual({ provider: 'stripe' });
    expect(withOptions.cause).toBe(cause);
  });

  it('carries details and ES2022 cause chaining (INV-3)', () => {
    const cause = new Error('root cause');
    const err = new ValidationError('bad input', { details: { field: 'email' }, cause });
    expect(err.details).toEqual({ field: 'email' });
    expect(err.cause).toBe(cause);
  });

  it('omits details when not provided (exactOptionalPropertyTypes-safe)', () => {
    const err = new NotFoundError('missing');
    expect(err.details).toBeUndefined();
    expect('details' in err).toBe(false);
  });

  it('isAppError rejects non-AppError values', () => {
    expect(isAppError(new Error('plain'))).toBe(false);
    expect(isAppError({ code: 'VALIDATION' })).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError('VALIDATION')).toBe(false);
    expect(isAppError(undefined)).toBe(false);
  });
});
