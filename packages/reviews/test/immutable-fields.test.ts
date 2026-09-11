import { ValidationError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';
import {
  productUpdateBindsFor,
  type UpdateProductInput,
} from '../src/internal/product-update-input.js';

describe('productUpdateBindsFor: the reviews.product immutability guard (SPEC-0002)', () => {
  it('rejects a patch carrying "slug", even though UpdateProductInput has no such field', () => {
    // A JSON body from the wire boundary can carry any key at runtime; UpdateProductInput's
    // static type is not a runtime guarantee. Built as a plain variable (never a literal argument)
    // so TypeScript's excess-property check on object literals cannot mask the very case this
    // guard exists for.
    const wireBody = { productSlug: 'sony-wh-1000xm5', slug: 'a-new-slug' };
    let caught: unknown;
    try {
      productUpdateBindsFor(wireBody);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).details).toEqual({ field: 'slug' });
  });

  it('rejects a patch carrying "sku"', () => {
    const wireBody = { productSlug: 'sony-wh-1000xm5', sku: 'NEW-SKU-1' };
    let caught: unknown;
    try {
      productUpdateBindsFor(wireBody);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).details).toEqual({ field: 'sku' });
  });

  it('rejects a patch with no mutable field at all', () => {
    const input: UpdateProductInput = { productSlug: 'sony-wh-1000xm5' };
    let caught: unknown;
    try {
      productUpdateBindsFor(input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).details).toEqual({ field: 'update' });
  });

  it('builds COALESCE binds for a partial patch, leaving every unset field null', () => {
    const input: UpdateProductInput = { productSlug: 'sony-wh-1000xm5', name: 'New name' };
    expect(productUpdateBindsFor(input)).toEqual({
      name: 'New name',
      description: null,
      productCategoryId: null,
      priceMinor: null,
      currencyCode: null,
    });
  });

  it('resolves categoryName through the compile-time PRODUCT_CATEGORY constant', () => {
    const input: UpdateProductInput = { productSlug: 'sony-wh-1000xm5', categoryName: 'audio' };
    expect(productUpdateBindsFor(input).productCategoryId).toBe(1);
  });

  it('resolves categoryName regardless of case or surrounding whitespace', () => {
    const input: UpdateProductInput = { productSlug: 'sony-wh-1000xm5', categoryName: 'Audio' };
    expect(productUpdateBindsFor(input).productCategoryId).toBe(1);
  });
});
