import type { ReviewSummary } from '@repo/contracts';
import { ERROR_CODE } from '@repo/kernel';
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
  StarRating,
} from '@repo/styles';
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useEffect, useId, useReducer } from 'react';
import { apiQuery } from '../../shared/api/index.js';
import { clearReviewDraft, readReviewDraft, writeReviewDraft } from './review-draft-storage.js';
import {
  initialReviewFormState,
  type ReviewFormInit,
  reviewFormReducer,
  validateReviewForm,
} from './review-form-machine.js';

const TITLE_MAX = 120;
const TITLE_WARN_REMAINING = 20;
const BODY_MAX = 4000;
const BODY_WARN_REMAINING = 200;

export interface ReviewSubmitFormProps {
  readonly productSlug: string;
  readonly productName: string;
  /** `'new'` is S4 opened from "Write a review"; `'edit'` re-uses the same form pre-filled
   * (SPEC-0001 J4) — `existingReview` is required in that mode. */
  readonly mode: 'new' | 'edit';
  readonly existingReview: ReviewSummary | undefined;
  /** Read from `useSession()` by the route (this slice never imports `shared/session` itself only
   * to keep the "who is signed in" read in one place) — drives J3's "sign-in prompt in place of the
   * submit button", proactively, before any submit attempt 401s. */
  readonly isSignedIn: boolean;
  readonly onSuccess: (review: ReviewSummary) => void;
  readonly onCancel: () => void;
  /** J6: "You have already reviewed this product" — the action the copy offers is "View your
   * review", which the ROUTE wires to closing this form and refreshing the review list (this slice
   * has no reach into `product-detail`'s query, by the slice-isolation rule). */
  readonly onConflict: () => void;
  /** J3's round trip: the route wires this to a `/sign-in` navigation carrying the current
   * `?review=new` URL as `returnTo`. */
  readonly onRequestSignIn: () => void;
}

function initFrom(props: ReviewSubmitFormProps): ReviewFormInit {
  if (props.mode === 'edit' && props.existingReview !== undefined) {
    return {
      rating: props.existingReview.rating,
      title: props.existingReview.title,
      body: props.existingReview.body,
    };
  }
  // 'new': the sessionStorage draft (J3) if one survived a sign-in round trip, otherwise blank.
  const draft = readReviewDraft(props.productSlug);
  return { rating: draft?.rating, title: draft?.title ?? '', body: draft?.body ?? '' };
}

/**
 * S4 — the review form (SPEC-0001), rendered in place on S3 via the `review` search param.
 *
 * Owns: the field state (`review-form-machine.ts`), the submit/update mutation, J3's draft
 * persistence, and the sign-in-prompt / error-by-code branching. Does NOT own: whether it is open
 * (the route's search param), the delete flow (S5, `delete-review-dialog.tsx`), or the review
 * list's invalidation timing beyond calling `onSuccess`.
 */
export function ReviewSubmitForm(props: ReviewSubmitFormProps) {
  const { productSlug, mode, isSignedIn, onSuccess, onCancel, onConflict, onRequestSignIn } = props;
  const ratingLabelId = useId();
  const titleFieldId = useId();
  const titleErrorId = useId();
  const bodyFieldId = useId();
  const bodyErrorId = useId();
  const formErrorId = useId();

  // Lazy init: read the draft/existing review exactly once, on mount — not on every re-render,
  // which would otherwise clobber in-progress typing with whatever is in storage.
  const [state, dispatch] = useReducer(reviewFormReducer, props, (initProps) =>
    initialReviewFormState(initFrom(initProps)),
  );

  // J3: written on every change, product-scoped, NEW mode only — an edit's starting point already
  // exists on the server, so there is nothing here for a sign-in round trip to preserve.
  useEffect(() => {
    if (mode !== 'new') {
      return;
    }
    writeReviewDraft(productSlug, { rating: state.rating, title: state.title, body: state.body });
  }, [mode, productSlug, state.rating, state.title, state.body]);

  const submitMutation = useMutation(apiQuery.reviews.submit.mutationOptions());
  const updateMutation = useMutation(apiQuery.reviews.update.mutationOptions());
  const isSubmitting = state.status === 'submitting';

  function handleCancel(): void {
    if (mode === 'new') {
      clearReviewDraft(productSlug);
    }
    onCancel();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (isSubmitting) {
      return;
    }
    const fieldErrors = validateReviewForm(state);
    if (Object.keys(fieldErrors).length > 0) {
      dispatch({ type: 'validationFailed', fieldErrors });
      return;
    }
    // `validateReviewForm` returning no `rating` error is what guarantees this — re-checked here,
    // narrowly, so the mutation input below never needs an assertion.
    const rating = state.rating;
    if (rating === undefined) {
      return;
    }

    dispatch({ type: 'submit' });
    try {
      const review =
        mode === 'edit' && props.existingReview !== undefined
          ? await updateMutation.mutateAsync({
              reviewToken: props.existingReview.token,
              rating,
              title: state.title,
              body: state.body,
            })
          : await submitMutation.mutateAsync({
              productSlug,
              rating,
              title: state.title,
              body: state.body,
            });
      if (mode === 'new') {
        clearReviewDraft(productSlug);
      }
      dispatch({ type: 'succeeded' });
      onSuccess(review);
    } catch (error) {
      dispatch({ type: 'failed', error });
    }
  }

  const titleRemaining = TITLE_MAX - state.title.length;
  const bodyRemaining = BODY_MAX - state.body.length;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <h2 className="text-title">{mode === 'edit' ? 'Edit your review' : 'Write a review'}</h2>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          <div className="flex flex-col gap-1">
            <span id={ratingLabelId} className="text-body font-medium text-content">
              Rating
            </span>
            <StarRating
              name={`review-rating-${productSlug}`}
              aria-labelledby={ratingLabelId}
              value={state.rating}
              disabled={isSubmitting}
              onChange={(rating) => dispatch({ type: 'setRating', rating })}
            />
            {state.fieldErrors.rating !== undefined && (
              <FieldError>{state.fieldErrors.rating}</FieldError>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor={titleFieldId}>Title</Label>
            <Input
              id={titleFieldId}
              value={state.title}
              maxLength={TITLE_MAX}
              disabled={isSubmitting}
              aria-invalid={state.fieldErrors.title !== undefined}
              aria-describedby={state.fieldErrors.title !== undefined ? titleErrorId : undefined}
              onChange={(event) => dispatch({ type: 'setTitle', title: event.target.value })}
            />
            <span
              className={cn(
                'text-caption',
                titleRemaining <= TITLE_WARN_REMAINING ? 'text-danger' : 'text-content-muted',
              )}
            >
              {state.title.length}/{TITLE_MAX}
            </span>
            {state.fieldErrors.title !== undefined && (
              <FieldError id={titleErrorId}>{state.fieldErrors.title}</FieldError>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor={bodyFieldId}>Review</Label>
            <textarea
              id={bodyFieldId}
              className={cn(inputVariants(), 'min-h-32 py-(--size-control-inset)')}
              value={state.body}
              maxLength={BODY_MAX}
              disabled={isSubmitting}
              aria-invalid={state.fieldErrors.body !== undefined}
              aria-describedby={state.fieldErrors.body !== undefined ? bodyErrorId : undefined}
              onChange={(event) => dispatch({ type: 'setBody', body: event.target.value })}
            />
            <span
              className={cn(
                'text-caption',
                bodyRemaining <= BODY_WARN_REMAINING ? 'text-danger' : 'text-content-muted',
              )}
            >
              {state.body.length}/{BODY_MAX}
            </span>
            {state.fieldErrors.body !== undefined && (
              <FieldError id={bodyErrorId}>{state.fieldErrors.body}</FieldError>
            )}
          </div>

          {state.formError !== undefined && (
            <div className="flex flex-col items-start gap-2">
              <FieldError id={formErrorId} data-testid="review-form-error">
                {state.formError}
              </FieldError>
              {state.formErrorCode === ERROR_CODE.Conflict && (
                <Button type="button" variant="outline" onClick={onConflict}>
                  View your review
                </Button>
              )}
            </div>
          )}

          <div className="flex gap-2">
            {isSignedIn ? (
              <Button type="submit" disabled={isSubmitting} data-testid="review-submit">
                {isSubmitting ? (
                  <>
                    <Spinner size="inline" label="Submitting…" />
                    Submitting…
                  </>
                ) : mode === 'edit' ? (
                  'Save changes'
                ) : (
                  'Submit review'
                )}
              </Button>
            ) : (
              // J3: a sign-in PROMPT in place of the submit button, never a modal — the draft stays
              // right here, already being written to sessionStorage above.
              <Button type="button" onClick={onRequestSignIn} data-testid="review-sign-in-prompt">
                Sign in to submit your review
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={handleCancel} disabled={isSubmitting}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
