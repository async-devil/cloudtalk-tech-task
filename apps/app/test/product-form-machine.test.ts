import { ERROR_CODE } from '@repo/kernel';
import { describe, expect, it } from 'vitest';
import {
  minorToPriceMajorInput,
  priceMajorToMinor,
} from '../src/features/catalogue-authoring/price-input.js';
import {
  initialProductFormState,
  productFormReducer,
  validateProductForm,
} from '../src/features/catalogue-authoring/product-form-machine.js';
import { deriveProductSlugPreview } from '../src/features/catalogue-authoring/slug-preview.js';
import { ApiError } from '../src/shared/errors/index.js';

/**
 * S7's form state (SPEC-0001) as a pure reducer, mirroring `review-form-machine.test.ts`'s own
 * shape: client-side validation, per-code error mapping, the double-submit guard, and — the one
 * behaviour unique to this form and the riskiest to get wrong — whether `slug` is included in the
 * `products.create` payload at all.
 */

describe('deriveProductSlugPreview — mirrors packages/reviews/src/products.ts deriveProductSlug', () => {
  it('lowercases and hyphenates', () => {
    expect(deriveProductSlugPreview('Sony WH-1000XM5')).toBe('sony-wh-1000xm5');
  });

  it('collapses runs of non-alphanumeric characters into a single hyphen', () => {
    expect(deriveProductSlugPreview('Sony  WH-1000XM5!!  ')).toBe('sony-wh-1000xm5');
  });

  it('trims leading and trailing hyphens', () => {
    expect(deriveProductSlugPreview('--Already Hyphenated--')).toBe('already-hyphenated');
  });

  it('trims to 80 characters, then trims a dangling trailing hyphen the cut can leave behind', () => {
    // Collapses to 79 'a's + '-' + 'bbb' (length 83); slicing at 80 lands exactly on that hyphen,
    // which the second trim must remove rather than leaving a dangling trailing '-'.
    const name = `${'a'.repeat(79)} bbb`;
    const preview = deriveProductSlugPreview(name);
    expect(preview).toBe('a'.repeat(79));
    expect(preview.endsWith('-')).toBe(false);
  });

  it('empty input derives to an empty string, never throws', () => {
    expect(deriveProductSlugPreview('')).toBe('');
  });
});

describe('priceMajorToMinor / minorToPriceMajorInput — round trip', () => {
  it('parses a two-decimal USD price into minor units', () => {
    expect(priceMajorToMinor('349.99', 'USD')).toBe(34999);
  });

  it('round-trips through minorToPriceMajorInput', () => {
    expect(minorToPriceMajorInput(34999, 'USD')).toBe('349.99');
  });

  it('rejects a negative price', () => {
    expect(priceMajorToMinor('-5', 'USD')).toBeUndefined();
  });

  it('rejects non-numeric text', () => {
    expect(priceMajorToMinor('not a price', 'USD')).toBeUndefined();
  });

  it('rejects an empty string', () => {
    expect(priceMajorToMinor('', 'USD')).toBeUndefined();
  });

  it('falls back to 2 decimal digits for a currency code Intl cannot resolve, rather than throwing', () => {
    expect(priceMajorToMinor('10', 'ZZZ')).toBe(1000);
  });
});

describe('validateProductForm — create mode', () => {
  const valid = {
    name: 'Sony WH-1000XM5',
    description: 'Noise-cancelling over-ear headphones.',
    categoryName: 'Audio',
    priceMajor: '349.99',
    currencyCode: 'USD',
    sku: 'AUD-WH1000XM5',
    slugTouched: false,
    slugValue: '',
  };

  it('passes a fully valid submission with no errors', () => {
    expect(validateProductForm(valid, 'create')).toEqual({});
  });

  it('requires name, description and category', () => {
    const errors = validateProductForm(
      { ...valid, name: '', description: '  ', categoryName: '' },
      'create',
    );
    expect(errors.name).toBeDefined();
    expect(errors.description).toBeDefined();
    expect(errors.categoryName).toBeDefined();
  });

  it('requires a valid price', () => {
    expect(validateProductForm({ ...valid, priceMajor: 'x' }, 'create').price).toBeDefined();
  });

  it('requires a 3-letter currency code', () => {
    expect(
      validateProductForm({ ...valid, currencyCode: 'usd' }, 'create').currencyCode,
    ).toBeDefined();
    expect(
      validateProductForm({ ...valid, currencyCode: 'US' }, 'create').currencyCode,
    ).toBeDefined();
  });

  it('requires a wire-shaped SKU', () => {
    expect(validateProductForm({ ...valid, sku: 'bad sku' }, 'create').sku).toBeDefined();
  });

  it('only validates slug once the user has touched it', () => {
    expect(
      validateProductForm({ ...valid, slugTouched: false, slugValue: '!!!' }, 'create').slug,
    ).toBeUndefined();
    expect(
      validateProductForm({ ...valid, slugTouched: true, slugValue: '!!!' }, 'create').slug,
    ).toBeDefined();
    expect(
      validateProductForm({ ...valid, slugTouched: true, slugValue: 'a-fine-slug' }, 'create').slug,
    ).toBeUndefined();
  });

  it('never validates sku/slug in edit mode', () => {
    const errors = validateProductForm(
      { ...valid, sku: '', slugTouched: true, slugValue: '!' },
      'edit',
    );
    expect(errors.sku).toBeUndefined();
    expect(errors.slug).toBeUndefined();
  });
});

describe('productFormReducer — the slug-touched flag (the safety-critical behaviour)', () => {
  it('starts untouched, with an empty slugValue', () => {
    const state = initialProductFormState();
    expect(state.slugTouched).toBe(false);
  });

  it('revealSlugEditor alone does NOT touch the slug — only setSlug does', () => {
    const start = initialProductFormState({ name: 'Sony WH-1000XM5' });
    const revealed = productFormReducer(start, { type: 'revealSlugEditor' });
    expect(revealed.slugEditorOpen).toBe(true);
    expect(revealed.slugTouched).toBe(false);
    // Seeded from the current preview so the user edits from a sane starting point.
    expect(revealed.slugValue).toBe('sony-wh-1000xm5');
  });

  it('setSlug marks slugTouched true and keeps it true on further name edits', () => {
    const start = initialProductFormState({ name: 'Sony WH-1000XM5' });
    const revealed = productFormReducer(start, { type: 'revealSlugEditor' });
    const edited = productFormReducer(revealed, { type: 'setSlug', slug: 'my-own-slug' });
    expect(edited.slugTouched).toBe(true);
    expect(edited.slugValue).toBe('my-own-slug');

    const renamed = productFormReducer(edited, { type: 'setName', name: 'A Totally New Name' });
    expect(renamed.slugTouched).toBe(true);
    expect(renamed.slugValue).toBe('my-own-slug');
  });

  it("re-opening the editor after it was touched does not clobber the user's own text", () => {
    const start = initialProductFormState({ name: 'Sony WH-1000XM5' });
    const touched = productFormReducer(productFormReducer(start, { type: 'revealSlugEditor' }), {
      type: 'setSlug',
      slug: 'my-own-slug',
    });
    const reopened = productFormReducer(touched, { type: 'revealSlugEditor' });
    expect(reopened.slugValue).toBe('my-own-slug');
  });
});

describe("productFormReducer — field edits clear that field's own error", () => {
  it('clears the name error (and any form-level error) the moment name is edited', () => {
    const start = initialProductFormState();
    const withErrors = productFormReducer(start, {
      type: 'validationFailed',
      fieldErrors: { name: 'Name is required.' },
    });
    expect(withErrors.fieldErrors.name).toBeDefined();

    const edited = productFormReducer(withErrors, { type: 'setName', name: 'A new name' });
    expect(edited.name).toBe('A new name');
    expect(edited.fieldErrors.name).toBeUndefined();
  });
});

describe('productFormReducer — double-submit guard', () => {
  it('a second submit while already submitting is a no-op', () => {
    const start = { ...initialProductFormState(), status: 'submitting' as const };
    const result = productFormReducer(start, { type: 'submit' });
    expect(result).toBe(start);
  });
});

describe('productFormReducer — server-answer-wins error mapping', () => {
  it('maps a CONFLICT on sku to the sku field, not a form-level banner', () => {
    const submitting = productFormReducer(initialProductFormState(), { type: 'submit' });
    const error = new ApiError(
      ERROR_CODE.Conflict,
      'A product with this slug or sku already exists.',
      409,
      { field: 'sku' },
    );
    const result = productFormReducer(submitting, { type: 'failed', error });
    expect(result.fieldErrors.sku).toBeDefined();
    expect(result.formError).toBeUndefined();
  });

  it("maps a VALIDATION on the wire's priceMinor to this form's price field", () => {
    const submitting = productFormReducer(initialProductFormState(), { type: 'submit' });
    const error = new ApiError(ERROR_CODE.Validation, 'The request was invalid.', 400, {
      field: 'priceMinor',
    });
    const result = productFormReducer(submitting, { type: 'failed', error });
    expect(result.fieldErrors.price).toBeDefined();
  });

  it('an UNAUTHORIZED failure renders nothing — the router-level 401 redirect owns it', () => {
    const submitting = productFormReducer(initialProductFormState(), { type: 'submit' });
    const error = new ApiError(ERROR_CODE.Unauthorized, 'A resolved session is required.', 401);
    const result = productFormReducer(submitting, { type: 'failed', error });
    expect(result.formError).toBeUndefined();
    expect(Object.keys(result.fieldErrors)).toHaveLength(0);
  });

  it('a CONFLICT with no recognised field falls back to the form-level banner', () => {
    const submitting = productFormReducer(initialProductFormState(), { type: 'submit' });
    const error = new ApiError(
      ERROR_CODE.Conflict,
      'A product with this slug or sku already exists.',
      409,
      { field: 'something-unrecognised' },
    );
    const result = productFormReducer(submitting, { type: 'failed', error });
    expect(result.formError).toBeDefined();
  });
});
