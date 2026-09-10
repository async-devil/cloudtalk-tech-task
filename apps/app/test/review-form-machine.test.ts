import { ERROR_CODE } from '@repo/kernel';
import { describe, expect, it } from 'vitest';
import {
  initialReviewFormState,
  reviewFormReducer,
  validateReviewForm,
} from '../src/features/review-submit/review-form-machine.js';
import { ApiError } from '../src/shared/errors/index.js';

/**
 * S4's form state (SPEC-0001) as a pure reducer — client-side validation mirroring the wire
 * schema, per-code error mapping, the double-submit guard, and "a failed submission never clears
 * the form".
 */

describe('validateReviewForm — mirrors the wire schema client-side', () => {
  it('requires a rating', () => {
    const errors = validateReviewForm({
      rating: undefined,
      title: 'A good title',
      body: 'A body long enough to pass.',
    });
    expect(errors.rating).toBeDefined();
    expect(errors.title).toBeUndefined();
    expect(errors.body).toBeUndefined();
  });

  it('requires a title between 3 and 120 characters (reviewTitleSchema)', () => {
    expect(
      validateReviewForm({ rating: 5, title: 'ab', body: 'A body long enough to pass.' }).title,
    ).toBeDefined();
    expect(
      validateReviewForm({ rating: 5, title: 'a'.repeat(121), body: 'A body long enough to pass.' })
        .title,
    ).toBeDefined();
    expect(
      validateReviewForm({ rating: 5, title: 'Just right', body: 'A body long enough to pass.' })
        .title,
    ).toBeUndefined();
  });

  it('requires a body between 10 and 4000 characters (reviewBodySchema)', () => {
    expect(
      validateReviewForm({ rating: 5, title: 'Just right', body: 'too short' }).body,
    ).toBeDefined();
    expect(
      validateReviewForm({ rating: 5, title: 'Just right', body: 'a'.repeat(4001) }).body,
    ).toBeDefined();
    expect(
      validateReviewForm({ rating: 5, title: 'Just right', body: 'A body long enough to pass.' })
        .body,
    ).toBeUndefined();
  });

  it('passes a fully valid submission with no errors at all', () => {
    expect(
      validateReviewForm({
        rating: 4,
        title: 'Solid pick',
        body: 'Comfortable and good battery life.',
      }),
    ).toEqual({});
  });
});

describe('reviewFormReducer — field edits', () => {
  it('clears that field error (and any form-level error) the moment the field is edited', () => {
    const start = initialReviewFormState({ rating: undefined, title: '', body: '' });
    const withErrors = reviewFormReducer(start, {
      type: 'validationFailed',
      fieldErrors: { title: 'Title must be between 3 and 120 characters.' },
    });
    expect(withErrors.fieldErrors.title).toBeDefined();

    const edited = reviewFormReducer(withErrors, { type: 'setTitle', title: 'A new title' });
    expect(edited.title).toBe('A new title');
    expect(edited.fieldErrors.title).toBeUndefined();
  });
});

describe('reviewFormReducer — submit / double-submit guard', () => {
  it('a second "submit" while already submitting is a no-op — the state is unchanged', () => {
    const editing = initialReviewFormState({
      rating: 5,
      title: 'Great',
      body: 'Really great product.',
    });
    const submitting = reviewFormReducer(editing, { type: 'submit' });
    expect(submitting.status).toBe('submitting');

    const secondSubmit = reviewFormReducer(submitting, { type: 'submit' });
    expect(secondSubmit).toBe(submitting);
  });
});

describe('reviewFormReducer — failed submission, by error code', () => {
  const editing = initialReviewFormState({
    rating: 5,
    title: 'Great product',
    body: 'Really happy with this purchase overall.',
  });
  const submitting = reviewFormReducer(editing, { type: 'submit' });

  it('UNAUTHORIZED renders NOTHING locally — the app-level redirect (J3) owns this case', () => {
    const failed = reviewFormReducer(submitting, {
      type: 'failed',
      error: new ApiError(ERROR_CODE.Unauthorized, 'nope', 401),
    });
    expect(failed.formError).toBeUndefined();
    expect(failed.fieldErrors).toEqual({});
    expect(failed.status).toBe('editing');
  });

  it('VALIDATION with details.field attaches the message to THAT field, not the form banner', () => {
    const failed = reviewFormReducer(submitting, {
      type: 'failed',
      error: new ApiError(ERROR_CODE.Validation, 'invalid', 400, { field: 'title' }),
    });
    expect(failed.fieldErrors.title).toBeDefined();
    expect(failed.formError).toBeUndefined();
  });

  it('VALIDATION with no recognisable field falls back to the form-level banner', () => {
    const failed = reviewFormReducer(submitting, {
      type: 'failed',
      error: new ApiError(ERROR_CODE.Validation, 'invalid', 400),
    });
    expect(failed.fieldErrors).toEqual({});
    expect(failed.formError).toBe('Please check what you entered and try again.');
  });

  it('CONFLICT (J6) renders the registered message and tags the code for the "View your review" action', () => {
    const failed = reviewFormReducer(submitting, {
      type: 'failed',
      error: new ApiError(ERROR_CODE.Conflict, 'already reviewed', 409),
    });
    expect(failed.formError).toBe('That has already changed. Reload and try again.');
    expect(failed.formErrorCode).toBe(ERROR_CODE.Conflict);
  });

  it('RATE_LIMITED says when to retry, via the registered message map', () => {
    const failed = reviewFormReducer(submitting, {
      type: 'failed',
      error: new ApiError(ERROR_CODE.RateLimited, 'slow down', 429),
    });
    expect(failed.formError).toBe('Too many requests. Please wait a moment and try again.');
  });

  it('a generic failure (e.g. INTERNAL) shows the generic copy — and NEVER clears the draft fields', () => {
    const failed = reviewFormReducer(submitting, {
      type: 'failed',
      error: new ApiError(ERROR_CODE.Internal, 'boom', 500),
    });
    expect(failed.formError).toBe('Something went wrong. Please try again.');
    // "Nothing is destroyed by a failed submission" (SPEC-0001 S4) — proven directly on the
    // fields, not just on the absence of a "clear" action.
    expect(failed.rating).toBe(5);
    expect(failed.title).toBe('Great product');
    expect(failed.body).toBe('Really happy with this purchase overall.');
    expect(failed.status).toBe('editing');
  });
});
