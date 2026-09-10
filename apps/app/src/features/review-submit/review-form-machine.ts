import { reviewBodySchema, reviewTitleSchema } from '@repo/contracts';
import { ERROR_CODE, type ErrorCode } from '@repo/kernel';
import { type ApiError, errorMessageFor, toApiError } from '../../shared/errors/index.js';

/**
 * S4's form state (SPEC-0001), a pure `useReducer` machine (ADR-0012, mirroring `sign-in`'s
 * `request-magic-link-machine.ts`) — separate from `review-submit-form.tsx` for the same reason
 * that file is separate there: the rules that matter — a failed submission never clears the form,
 * a double submit is refused, a field edit clears that field's own error — are testable with no
 * component rendered.
 */

export interface ReviewFormFieldErrors {
  // `| undefined` spelled out on every field (not just `?`), which `exactOptionalPropertyTypes`
  // treats as a DIFFERENT type: the reducer clears one field's error by assigning `undefined`
  // explicitly (`{ ...state.fieldErrors, rating: undefined }`) rather than omitting the key, and
  // that assignment needs the wider type to type-check under the flag.
  readonly rating?: string | undefined;
  readonly title?: string | undefined;
  readonly body?: string | undefined;
}

export interface ReviewFormState {
  readonly rating: number | undefined;
  readonly title: string;
  readonly body: string;
  readonly status: 'editing' | 'submitting';
  readonly fieldErrors: ReviewFormFieldErrors;
  /** Form-level copy for an error `details` could not attach to a specific field — `undefined`
   * whenever `fieldErrors` already says everything there is to say. */
  readonly formError: string | undefined;
  /** Carried alongside `formError` so the component can render a code-specific ACTION (J6's "View
   * your review" on `CONFLICT`) without re-deriving the code from the message string. */
  readonly formErrorCode: ErrorCode | undefined;
}

export interface ReviewFormInit {
  readonly rating: number | undefined;
  readonly title: string;
  readonly body: string;
}

export function initialReviewFormState(init: ReviewFormInit): ReviewFormState {
  return {
    rating: init.rating,
    title: init.title,
    body: init.body,
    status: 'editing',
    fieldErrors: {},
    formError: undefined,
    formErrorCode: undefined,
  };
}

export type ReviewFormAction =
  | { readonly type: 'setRating'; readonly rating: number }
  | { readonly type: 'setTitle'; readonly title: string }
  | { readonly type: 'setBody'; readonly body: string }
  | { readonly type: 'validationFailed'; readonly fieldErrors: ReviewFormFieldErrors }
  | { readonly type: 'submit' }
  | { readonly type: 'succeeded' }
  | { readonly type: 'failed'; readonly error: unknown };

/**
 * Client-side validation MIRRORING the wire schema (`ratingSchema`/`reviewTitleSchema`/
 * `reviewBodySchema` — imported directly for the two Zod schemas rather than restating their
 * bounds as literals, so a future change to either schema cannot drift from this copy silently),
 * exactly what SPEC-0001 S4 asks for: "client-side validation mirrors the wire schema… the server's
 * answer wins." This function only ever produces a HINT before a round trip; `failed` below is what
 * renders the server's own answer, and it always overrides whatever this function said.
 */
export function validateReviewForm(input: ReviewFormInit): ReviewFormFieldErrors {
  const errors: { -readonly [K in keyof ReviewFormFieldErrors]?: string } = {};
  if (input.rating === undefined) {
    errors.rating = 'Choose a rating from 1 to 5 stars.';
  }
  if (!reviewTitleSchema.safeParse(input.title).success) {
    errors.title = 'Title must be between 3 and 120 characters.';
  }
  if (!reviewBodySchema.safeParse(input.body).success) {
    errors.body = 'Review must be between 10 and 4000 characters.';
  }
  return errors;
}

/**
 * Maps a server `VALIDATION` failure's `details` onto a field, following the ONE convention this
 * codebase's other `VALIDATION`/`CONFLICT` throws already use (`details.field`, e.g.
 * `decodeCursor`'s `details: { field: 'cursor' }`, `products.create`'s slug/sku `CONFLICT`) —
 * there is no per-field MESSAGE on the wire (`apiErrorShape.details` is an open
 * `Record<string, unknown>`, TASK-0004's own note), so the field gets the same registered
 * `VALIDATION` copy the form-level banner would otherwise show, attached to the input the server
 * actually objected to instead of floating free of it.
 */
function fieldErrorsFromApiError(apiError: ApiError): ReviewFormFieldErrors {
  const field = apiError.details?.field;
  if (field === 'rating' || field === 'title' || field === 'body') {
    return { [field]: errorMessageFor(apiError.code) };
  }
  return {};
}

export function reviewFormReducer(
  state: ReviewFormState,
  action: ReviewFormAction,
): ReviewFormState {
  switch (action.type) {
    case 'setRating':
      return {
        ...state,
        rating: action.rating,
        fieldErrors: { ...state.fieldErrors, rating: undefined },
        formError: undefined,
        formErrorCode: undefined,
      };
    case 'setTitle':
      return {
        ...state,
        title: action.title,
        fieldErrors: { ...state.fieldErrors, title: undefined },
        formError: undefined,
        formErrorCode: undefined,
      };
    case 'setBody':
      return {
        ...state,
        body: action.body,
        fieldErrors: { ...state.fieldErrors, body: undefined },
        formError: undefined,
        formErrorCode: undefined,
      };
    case 'validationFailed':
      return { ...state, fieldErrors: action.fieldErrors };
    case 'submit':
      // Guarded here AND at the call site (`review-submit-form.tsx` checks `status` before
      // dispatching) — the same double lock `request-magic-link-machine.ts`'s own `submit` case
      // documents: a second `Enter` or a second click must not spend a second mutation.
      if (state.status === 'submitting') {
        return state;
      }
      return {
        ...state,
        status: 'submitting',
        fieldErrors: {},
        formError: undefined,
        formErrorCode: undefined,
      };
    case 'succeeded':
      return { ...state, status: 'editing' };
    case 'failed': {
      const apiError = toApiError(action.error);
      // UNAUTHORIZED is deliberately rendered as NOTHING here: `shared/errors`'
      // `installUnauthorizedRedirect` (installed once, router-level) already turns this into a
      // navigation to `/sign-in` with the current URL (this exact `?review=new` location) as
      // `returnTo` — J3's round trip. A form-level error banner would show for the instant before
      // that redirect fires and then vanish, which is worse than showing nothing.
      if (apiError.code === ERROR_CODE.Unauthorized) {
        return { ...state, status: 'editing' };
      }
      if (apiError.code === ERROR_CODE.Validation) {
        const fieldErrors = fieldErrorsFromApiError(apiError);
        const attachedToAField = Object.keys(fieldErrors).length > 0;
        return {
          ...state,
          status: 'editing',
          fieldErrors,
          formError: attachedToAField ? undefined : errorMessageFor(apiError.code),
          formErrorCode: apiError.code,
        };
      }
      // CONFLICT (J6), RATE_LIMITED, and everything else: one generic-or-specific banner, the
      // draft left completely intact — "nothing is destroyed by a failed submission" (SPEC-0001
      // S4), which this branch satisfies simply by never touching `title`/`body`/`rating` above.
      return {
        ...state,
        status: 'editing',
        formError: errorMessageFor(apiError.code),
        formErrorCode: apiError.code,
      };
    }
  }
}
