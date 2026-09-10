import type { ReviewSummary } from '@repo/contracts';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  FieldError,
} from '@repo/styles';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { apiQuery } from '../../shared/api/index.js';
import { errorMessageFor, toApiError } from '../../shared/errors/index.js';

export interface DeleteReviewDialogProps {
  readonly productName: string;
  readonly review: ReviewSummary;
  /** Called after a successful delete — the route wires this to the SAME review-list query
   * `review-submit-form.tsx`'s `onSuccess` invalidates, never a direct import of `product-detail`
   * (the slice-isolation rule). */
  readonly onDeleted: () => void;
}

/**
 * S5 — the delete confirmation (SPEC-0001), on top of `@repo/styles`' `Dialog` (Stage A). Names the
 * product and the rating being removed, matches `dialog.test.tsx`'s own fixture copy shape exactly
 * ("Delete this review?" / "This removes your N-star rating of {product}."), and disables BOTH
 * actions while the delete is in flight rather than closing optimistically.
 */
export function DeleteReviewDialog({ productName, review, onDeleted }: DeleteReviewDialogProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const removeMutation = useMutation(apiQuery.reviews.remove.mutationOptions());

  async function handleConfirm(): Promise<void> {
    setError(undefined);
    try {
      await removeMutation.mutateAsync({ reviewToken: review.token });
      setOpen(false);
      onDeleted();
    } catch (caught) {
      setError(errorMessageFor(toApiError(caught).code));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Blocks EVERY dismissal path while in flight — Escape, the backdrop, the corner close
        // button — not only the two footer buttons: "disables both actions rather than closing
        // optimistically" (SPEC-0001 S5) is a statement about the WHOLE dialog's exit, not just
        // the two labelled buttons.
        if (!removeMutation.isPending) {
          setOpen(next);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          Delete
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this review?</DialogTitle>
          <DialogDescription>
            This removes your {review.rating}-star rating of {productName}.
          </DialogDescription>
        </DialogHeader>
        {error !== undefined && <FieldError data-testid="delete-review-error">{error}</FieldError>}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={removeMutation.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={removeMutation.isPending}
            onClick={() => void handleConfirm()}
          >
            {removeMutation.isPending ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
