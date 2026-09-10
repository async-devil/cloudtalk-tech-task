import { productSlugSchema, skuSchema } from '@repo/contracts';
import { ERROR_CODE, type ErrorCode } from '@repo/kernel';
import { type ApiError, errorMessageFor, toApiError } from '../../shared/errors/index.js';
import { priceMajorToMinor } from './price-input.js';
import { deriveProductSlugPreview } from './slug-preview.js';

/**
 * S7's form state (SPEC-0001), a pure `useReducer` machine — the same shape
 * `review-form-machine.ts` establishes (client-side validation mirroring the wire schema,
 * per-code error mapping via `details.field`, a double-submit guard, "a failed submission never
 * clears the form") rather than a new pattern invented for this form.
 */

export interface ProductFormFieldErrors {
  // `| undefined` spelled out (not just `?`) for the same `exactOptionalPropertyTypes` reason
  // `review-form-machine.ts` documents: the reducer clears one field's error by assigning
  // `undefined` explicitly.
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly categoryName?: string | undefined;
  readonly price?: string | undefined;
  readonly currencyCode?: string | undefined;
  readonly sku?: string | undefined;
  readonly slug?: string | undefined;
}

export interface ProductFormState {
  readonly name: string;
  readonly description: string;
  readonly categoryName: string;
  /** Human-typed price text (e.g. `"349.99"`), converted to `priceMinor` on submit
   * (`price-input.ts`) — never stored as minor units while the form is open. */
  readonly priceMajor: string;
  readonly currencyCode: string;
  readonly sku: string;
  /** CREATE only — reveals the editable slug field. Always `false` in edit mode and never
   * flipped there (the component never wires the toggle in edit mode). */
  readonly slugEditorOpen: boolean;
  /** The user's own edited slug text, once `slugTouched`. Meaningless (and never read) before
   * that — the PREVIEW shown to the user is derived fresh from `name` every render instead. */
  readonly slugValue: string;
  /** Set exactly once, by `setSlug` — the ONLY action that can make it `true`. This is the flag
   * `product-form.tsx`'s submit handler reads to decide whether `slug` is included in the
   * `products.create` payload at all (SPEC-0001: "a client-side slug is a suggestion… treating it
   * as the value makes the address depend on which client wrote the row"). */
  readonly slugTouched: boolean;
  readonly status: 'editing' | 'submitting';
  readonly fieldErrors: ProductFormFieldErrors;
  readonly formError: string | undefined;
  readonly formErrorCode: ErrorCode | undefined;
}

export interface ProductFormInit {
  readonly name: string;
  readonly description: string;
  readonly categoryName: string;
  readonly priceMajor: string;
  readonly currencyCode: string;
  readonly sku: string;
}

/** Seed data has always priced in USD (`packages/entities`' seeded catalogue) — a sane default for
 * a brand-new product, not a claim about every deployment. */
const DEFAULT_CURRENCY_CODE = 'USD';

export function initialProductFormState(init: Partial<ProductFormInit> = {}): ProductFormState {
  return {
    name: init.name ?? '',
    description: init.description ?? '',
    categoryName: init.categoryName ?? '',
    priceMajor: init.priceMajor ?? '',
    currencyCode: init.currencyCode ?? DEFAULT_CURRENCY_CODE,
    sku: init.sku ?? '',
    slugEditorOpen: false,
    slugValue: '',
    slugTouched: false,
    status: 'editing',
    fieldErrors: {},
    formError: undefined,
    formErrorCode: undefined,
  };
}

export type ProductFormAction =
  | { readonly type: 'setName'; readonly name: string }
  | { readonly type: 'setDescription'; readonly description: string }
  | { readonly type: 'setCategoryName'; readonly categoryName: string }
  | { readonly type: 'setPriceMajor'; readonly priceMajor: string }
  | { readonly type: 'setCurrencyCode'; readonly currencyCode: string }
  | { readonly type: 'setSku'; readonly sku: string }
  | { readonly type: 'revealSlugEditor' }
  | { readonly type: 'setSlug'; readonly slug: string }
  | { readonly type: 'validationFailed'; readonly fieldErrors: ProductFormFieldErrors }
  | { readonly type: 'submit' }
  | { readonly type: 'succeeded' }
  | { readonly type: 'failed'; readonly error: unknown };

export interface ProductFormValidationInput {
  readonly name: string;
  readonly description: string;
  readonly categoryName: string;
  readonly priceMajor: string;
  readonly currencyCode: string;
  readonly sku: string;
  readonly slugTouched: boolean;
  readonly slugValue: string;
}

/**
 * Client-side validation MIRRORING the wire schema (`productsCreateInputSchema`,
 * `productsUpdateInputSchema` — not exported from `@repo/contracts`, so their trivial bounds
 * beyond `productSlugSchema`/`skuSchema` are restated as plain checks here, the same way
 * `productSummarySchema`'s own doc treats `description`'s bound as "no more than `NOT NULL`"). A
 * HINT before a round trip; the server's answer always wins (`failed` below).
 *
 * `sku`/`slug` are only ever checked in `create` mode — edit mode never lets either field be
 * edited, so validating them there would be validating a value the form never sends.
 */
export function validateProductForm(
  input: ProductFormValidationInput,
  mode: 'create' | 'edit',
): ProductFormFieldErrors {
  const errors: { -readonly [K in keyof ProductFormFieldErrors]?: string } = {};
  if (input.name.trim() === '') {
    errors.name = 'Name is required.';
  }
  if (input.description.trim() === '') {
    errors.description = 'Description is required.';
  }
  if (input.categoryName.trim() === '') {
    errors.categoryName = 'Category is required.';
  }
  if (priceMajorToMinor(input.priceMajor, input.currencyCode) === undefined) {
    errors.price = 'Enter a price of 0 or more, e.g. 349.99.';
  }
  if (!/^[A-Z]{3}$/.test(input.currencyCode)) {
    errors.currencyCode = 'Enter a 3-letter currency code, e.g. USD.';
  }
  if (mode === 'create') {
    if (!skuSchema.safeParse(input.sku).success) {
      errors.sku =
        'Uppercase letters, digits and hyphens only, 3-32 characters, e.g. AUD-WH1000XM5.';
    }
    if (input.slugTouched && !productSlugSchema.safeParse(input.slugValue).success) {
      errors.slug = 'Lowercase letters, digits and hyphens only, 3-80 characters.';
    }
  }
  return errors;
}

/** The wire's `details.field` names (`productsCreateInputSchema`/`productsUpdateInputSchema`'s own
 * keys, e.g. `priceMinor`) mapped onto this form's UI field slots (e.g. `price`) — the two
 * deliberately differ (the form collects a human price, the wire carries minor units), so unlike
 * `review-form-machine.ts`'s identical wire/UI field names, this mapping cannot be a bare identity
 * check. */
const WIRE_FIELD_TO_UI_FIELD: Readonly<Record<string, keyof ProductFormFieldErrors>> = {
  name: 'name',
  description: 'description',
  categoryName: 'categoryName',
  priceMinor: 'price',
  currencyCode: 'currencyCode',
  sku: 'sku',
  slug: 'slug',
};

/**
 * Maps a server `VALIDATION`/`CONFLICT` failure's `details.field` onto this form's field slots —
 * same convention `review-form-machine.ts`'s `fieldErrorsFromApiError` establishes
 * (`products.create`'s own slug/sku `CONFLICT` is exactly the precedent named in that file's own
 * doc comment). Unrecognised or absent `field` falls back to the form-level banner.
 */
function fieldErrorsFromApiError(apiError: ApiError): ProductFormFieldErrors {
  const field = apiError.details?.field;
  if (typeof field !== 'string') {
    return {};
  }
  const uiField = WIRE_FIELD_TO_UI_FIELD[field];
  if (uiField === undefined) {
    return {};
  }
  return { [uiField]: errorMessageFor(apiError.code) };
}

export function productFormReducer(
  state: ProductFormState,
  action: ProductFormAction,
): ProductFormState {
  switch (action.type) {
    case 'setName':
      return {
        ...state,
        name: action.name,
        fieldErrors: { ...state.fieldErrors, name: undefined },
        formError: undefined,
        formErrorCode: undefined,
      };
    case 'setDescription':
      return {
        ...state,
        description: action.description,
        fieldErrors: { ...state.fieldErrors, description: undefined },
        formError: undefined,
        formErrorCode: undefined,
      };
    case 'setCategoryName':
      return {
        ...state,
        categoryName: action.categoryName,
        fieldErrors: { ...state.fieldErrors, categoryName: undefined },
        formError: undefined,
        formErrorCode: undefined,
      };
    case 'setPriceMajor':
      return {
        ...state,
        priceMajor: action.priceMajor,
        fieldErrors: { ...state.fieldErrors, price: undefined },
        formError: undefined,
        formErrorCode: undefined,
      };
    case 'setCurrencyCode':
      return {
        ...state,
        currencyCode: action.currencyCode,
        fieldErrors: { ...state.fieldErrors, currencyCode: undefined },
        formError: undefined,
        formErrorCode: undefined,
      };
    case 'setSku':
      return {
        ...state,
        sku: action.sku,
        fieldErrors: { ...state.fieldErrors, sku: undefined },
        formError: undefined,
        formErrorCode: undefined,
      };
    case 'revealSlugEditor':
      // Seeds the field with the CURRENT preview so the user edits from a sane starting point
      // rather than a blank one — but only the first time: re-opening after already having
      // touched it must not clobber what they typed.
      return {
        ...state,
        slugEditorOpen: true,
        slugValue: state.slugTouched ? state.slugValue : deriveProductSlugPreview(state.name),
      };
    case 'setSlug':
      // The ONLY place `slugTouched` becomes `true` (see the field's own doc comment above).
      return {
        ...state,
        slugValue: action.slug,
        slugTouched: true,
        fieldErrors: { ...state.fieldErrors, slug: undefined },
        formError: undefined,
        formErrorCode: undefined,
      };
    case 'validationFailed':
      return { ...state, fieldErrors: action.fieldErrors };
    case 'submit':
      // Guarded here AND at the call site, same double lock `review-form-machine.ts`'s own
      // `submit` case documents: a second `Enter` must not spend a second mutation.
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
      // UNAUTHORIZED renders as NOTHING here, same reasoning `review-form-machine.ts` documents:
      // `shared/errors`' `installUnauthorizedRedirect` is a ROUTER-LEVEL subscriber on BOTH the
      // query AND mutation caches (its own header is explicit: "a session can expire just as
      // easily under a mutation as under a read"), so it already redirects to `/sign-in` before
      // this branch would ever get to show a banner — showing one anyway would just flash before
      // the navigation.
      if (apiError.code === ERROR_CODE.Unauthorized) {
        return { ...state, status: 'editing' };
      }
      if (apiError.code === ERROR_CODE.Validation || apiError.code === ERROR_CODE.Conflict) {
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
      // Everything else: one generic-or-specific banner, the draft left completely intact —
      // "nothing in the form is cleared" (SPEC-0001 S7), satisfied simply by never touching any
      // field above.
      return {
        ...state,
        status: 'editing',
        formError: errorMessageFor(apiError.code),
        formErrorCode: apiError.code,
      };
    }
  }
}
