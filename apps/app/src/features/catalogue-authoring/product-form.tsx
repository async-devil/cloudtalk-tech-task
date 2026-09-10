import type { ProductDetail } from '@repo/contracts';
import {
  Button,
  Card,
  CardContent,
  cn,
  FieldError,
  Input,
  inputVariants,
  Label,
  Spinner,
} from '@repo/styles';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useReducer } from 'react';
import { apiQuery } from '../../shared/api/index.js';
import { queryKeys } from '../../shared/query-keys/index.js';
import { minorToPriceMajorInput, priceMajorToMinor } from './price-input.js';
import {
  initialProductFormState,
  type ProductFormInit,
  productFormReducer,
  validateProductForm,
} from './product-form-machine.js';
import { deriveProductSlugPreview } from './slug-preview.js';

export interface ProductFormProps {
  readonly mode: 'create' | 'edit';
  /** Required when `mode === 'edit'` — the route's loader already primed this via
   * `product-detail`'s own `productDetailQueryOptions` before this form ever mounts. Optional in
   * the type only so `create` mode has nothing to pass. */
  readonly product?: ProductDetail;
  readonly onSuccess: (product: ProductDetail) => void;
  readonly onCancel: () => void;
}

function initFrom(props: ProductFormProps): Partial<ProductFormInit> | undefined {
  if (props.mode === 'edit' && props.product !== undefined) {
    const product = props.product;
    return {
      name: product.name,
      description: product.description,
      categoryName: product.categoryName,
      priceMajor: minorToPriceMajorInput(product.priceMinor, product.currencyCode),
      currencyCode: product.currencyCode,
      sku: product.sku,
    };
  }
  return undefined;
}

/**
 * S7 — the product create/edit form (SPEC-0001, TASK-0008), rendered by `routes/products/new.tsx`
 * and `routes/products/$productSlug/edit.tsx`.
 *
 * Owns: field state (`product-form-machine.ts`), the create/update mutation, and the
 * error-by-code branching. Does NOT own: whether the route is reachable at all (both routes'
 * `beforeLoad` — the courtesy gate) or navigation after success/cancel (the routes' `onSuccess`/
 * `onCancel` props, mirroring `review-submit-form.tsx`'s identical split).
 */
export function ProductForm(props: ProductFormProps) {
  const { mode, onSuccess, onCancel } = props;
  const nameFieldId = useId();
  const descriptionFieldId = useId();
  const descriptionErrorId = useId();
  const categoryFieldId = useId();
  const categoryErrorId = useId();
  const priceFieldId = useId();
  const priceErrorId = useId();
  const currencyFieldId = useId();
  const currencyErrorId = useId();
  const skuFieldId = useId();
  const skuErrorId = useId();
  const slugFieldId = useId();
  const slugErrorId = useId();
  const slugPreviewId = useId();
  const formErrorId = useId();

  const [state, dispatch] = useReducer(productFormReducer, props, (initProps) =>
    initialProductFormState(initFrom(initProps)),
  );

  const queryClient = useQueryClient();
  const createMutation = useMutation(apiQuery.products.create.mutationOptions());
  const updateMutation = useMutation(apiQuery.products.update.mutationOptions());
  const isSubmitting = state.status === 'submitting';

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (isSubmitting) {
      return;
    }

    const fieldErrors = validateProductForm(state, mode);
    if (Object.keys(fieldErrors).length > 0) {
      dispatch({ type: 'validationFailed', fieldErrors });
      return;
    }
    // `validateProductForm` returning no `price` error is what guarantees this parses — re-checked
    // narrowly, same precedent `review-submit-form.tsx`'s own `rating` re-check follows.
    const priceMinor = priceMajorToMinor(state.priceMajor, state.currencyCode);
    if (priceMinor === undefined) {
      return;
    }

    dispatch({ type: 'submit' });
    try {
      let result: ProductDetail;
      if (mode === 'create') {
        result = await createMutation.mutateAsync({
          name: state.name,
          description: state.description,
          categoryName: state.categoryName,
          priceMinor,
          currencyCode: state.currencyCode,
          sku: state.sku,
          // Only included when the user explicitly edited the revealed field (SPEC-0001: "a
          // client-side slug is a suggestion… treating it as the value makes the address depend
          // on which client wrote the row") — an untouched preview is never sent, and the server
          // derives the real value from `name` itself.
          ...(state.slugTouched ? { slug: state.slugValue } : {}),
        });
      } else {
        const productSlug = props.product?.slug;
        if (productSlug === undefined) {
          return;
        }
        // Built as EXACTLY these six keys — never a spread from `props.product` or from anything
        // that could carry `slug`/`sku` through. `productsUpdateInputSchema` already rejects
        // either at the wire (`.strict()`, TASK-0008's own "immutability proven twice" note); this
        // object literal is the client-side half of that same proof — there is no code path
        // through this literal that could grow either key.
        result = await updateMutation.mutateAsync({
          productSlug,
          name: state.name,
          description: state.description,
          categoryName: state.categoryName,
          priceMinor,
          currencyCode: state.currencyCode,
        });
      }
      dispatch({ type: 'succeeded' });
      // The catalogue list may now show a new row (create) or a changed name/category/price
      // (edit); the detail cache for THIS slug may also be stale (edit only — create has no
      // prior cache entry to invalidate).
      void queryClient.invalidateQueries({ queryKey: queryKeys.products.all });
      if (mode === 'edit') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.products.get(result.slug) });
      }
      onSuccess(result);
    } catch (error) {
      dispatch({ type: 'failed', error });
    }
  }

  const slugPreview = state.slugTouched ? state.slugValue : deriveProductSlugPreview(state.name);

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          <div className="flex flex-col gap-1">
            <Label htmlFor={nameFieldId}>Name</Label>
            <Input
              id={nameFieldId}
              value={state.name}
              disabled={isSubmitting}
              aria-invalid={state.fieldErrors.name !== undefined}
              onChange={(event) => dispatch({ type: 'setName', name: event.target.value })}
            />
            {state.fieldErrors.name !== undefined && (
              <FieldError>{state.fieldErrors.name}</FieldError>
            )}
          </div>

          {mode === 'create' &&
            (state.slugEditorOpen ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor={slugFieldId}>Slug</Label>
                <Input
                  id={slugFieldId}
                  value={state.slugValue}
                  disabled={isSubmitting}
                  aria-invalid={state.fieldErrors.slug !== undefined}
                  aria-describedby={state.fieldErrors.slug !== undefined ? slugErrorId : undefined}
                  onChange={(event) => dispatch({ type: 'setSlug', slug: event.target.value })}
                />
                {state.fieldErrors.slug !== undefined && (
                  <FieldError id={slugErrorId}>{state.fieldErrors.slug}</FieldError>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <p
                  id={slugPreviewId}
                  aria-live="polite"
                  className="text-caption text-content-muted"
                >
                  Will be published at <code>/products/{slugPreview || '…'}</code>
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isSubmitting}
                  data-testid="edit-slug-button"
                  onClick={() => dispatch({ type: 'revealSlugEditor' })}
                >
                  Edit slug
                </Button>
              </div>
            ))}

          {mode === 'edit' && props.product !== undefined && (
            <div className="flex flex-col gap-1">
              <Label htmlFor={slugFieldId}>Slug</Label>
              <Input id={slugFieldId} value={props.product.slug} disabled />
              <p className="text-caption text-content-muted">
                The address is fixed so links keep working.
              </p>
            </div>
          )}

          <div className="flex flex-col gap-1">
            <Label htmlFor={descriptionFieldId}>Description</Label>
            <textarea
              id={descriptionFieldId}
              className={cn(inputVariants(), 'min-h-32 py-(--size-control-inset)')}
              value={state.description}
              disabled={isSubmitting}
              aria-invalid={state.fieldErrors.description !== undefined}
              aria-describedby={
                state.fieldErrors.description !== undefined ? descriptionErrorId : undefined
              }
              onChange={(event) =>
                dispatch({ type: 'setDescription', description: event.target.value })
              }
            />
            {state.fieldErrors.description !== undefined && (
              <FieldError id={descriptionErrorId}>{state.fieldErrors.description}</FieldError>
            )}
          </div>

          {/* Free text, not a `<select>` (SPEC-0001 S7 says "a select over the vocabulary", but —
              same reasoning `catalogue-screen.tsx`'s own category FILTER documents — there is no
              wire-exposed category vocabulary anywhere in `@repo/contracts`; the categories live
              in `@repo/entities`, a backend package with no sanctioned frontend edge to it. A real
              `<select>` needs a new backend endpoint listing `PRODUCT_CATEGORY`, which is out of
              scope for this dispatch — flagged as a follow-up, not built here.) */}
          <div className="flex flex-col gap-1">
            <Label htmlFor={categoryFieldId}>Category</Label>
            <Input
              id={categoryFieldId}
              value={state.categoryName}
              disabled={isSubmitting}
              aria-invalid={state.fieldErrors.categoryName !== undefined}
              aria-describedby={
                state.fieldErrors.categoryName !== undefined ? categoryErrorId : undefined
              }
              onChange={(event) =>
                dispatch({ type: 'setCategoryName', categoryName: event.target.value })
              }
            />
            {state.fieldErrors.categoryName !== undefined && (
              <FieldError id={categoryErrorId}>{state.fieldErrors.categoryName}</FieldError>
            )}
          </div>

          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor={priceFieldId}>Price</Label>
              <Input
                id={priceFieldId}
                inputMode="decimal"
                placeholder="349.99"
                value={state.priceMajor}
                disabled={isSubmitting}
                aria-invalid={state.fieldErrors.price !== undefined}
                aria-describedby={state.fieldErrors.price !== undefined ? priceErrorId : undefined}
                onChange={(event) =>
                  dispatch({ type: 'setPriceMajor', priceMajor: event.target.value })
                }
              />
              {state.fieldErrors.price !== undefined && (
                <FieldError id={priceErrorId}>{state.fieldErrors.price}</FieldError>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={currencyFieldId}>Currency</Label>
              <Input
                id={currencyFieldId}
                placeholder="USD"
                value={state.currencyCode}
                disabled={isSubmitting}
                aria-invalid={state.fieldErrors.currencyCode !== undefined}
                aria-describedby={
                  state.fieldErrors.currencyCode !== undefined ? currencyErrorId : undefined
                }
                onChange={(event) =>
                  dispatch({
                    type: 'setCurrencyCode',
                    currencyCode: event.target.value.toUpperCase(),
                  })
                }
              />
              <span className="text-caption text-content-muted">3-letter ISO code, e.g. USD.</span>
              {state.fieldErrors.currencyCode !== undefined && (
                <FieldError id={currencyErrorId}>{state.fieldErrors.currencyCode}</FieldError>
              )}
            </div>
          </div>

          {mode === 'create' ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor={skuFieldId}>SKU</Label>
              <Input
                id={skuFieldId}
                value={state.sku}
                disabled={isSubmitting}
                aria-invalid={state.fieldErrors.sku !== undefined}
                aria-describedby={skuErrorId}
                onChange={(event) =>
                  dispatch({ type: 'setSku', sku: event.target.value.toUpperCase() })
                }
              />
              <span id={skuErrorId} className="text-caption text-content-muted">
                Uppercase letters, digits and hyphens only, 3-32 characters.
              </span>
              {state.fieldErrors.sku !== undefined && (
                <FieldError>{state.fieldErrors.sku}</FieldError>
              )}
            </div>
          ) : (
            props.product !== undefined && (
              <div className="flex flex-col gap-1">
                <Label htmlFor={skuFieldId}>SKU</Label>
                <Input id={skuFieldId} value={props.product.sku} disabled />
                <p className="text-caption text-content-muted">
                  The SKU is fixed so warehouse records keep matching.
                </p>
              </div>
            )
          )}

          {state.formError !== undefined && (
            <FieldError id={formErrorId} data-testid="product-form-error">
              {state.formError}
            </FieldError>
          )}

          <div className="flex gap-2">
            <Button type="submit" disabled={isSubmitting} data-testid="product-form-submit">
              {isSubmitting ? (
                <>
                  <Spinner size="inline" label="Saving…" />
                  Saving…
                </>
              ) : mode === 'edit' ? (
                'Save changes'
              ) : (
                'Create product'
              )}
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
