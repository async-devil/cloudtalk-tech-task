import { ERROR_CODE } from '@repo/kernel';
import { Button, Card, CardContent, Label } from '@repo/styles';
import { useMutation } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { apiQuery } from '../../shared/api/index.js';
import type { ApiError } from '../../shared/errors/index.js';
import { errorMessageFor, toApiError } from '../../shared/errors/index.js';
import { ModerationRow } from './moderation-row.js';
import { type ModerationState, useModerationReviews } from './use-moderation-reviews.js';

const SKELETON_COUNT = 3;

const MODERATION_STATES: readonly ModerationState[] = ['published', 'rejected'];
const STATE_LABEL: Readonly<Record<ModerationState, string>> = {
  published: 'Published',
  rejected: 'Rejected',
};

/**
 * S8 — review moderation (SPEC-0001), rendered by `routes/moderation.tsx`. Reachable — courtesy
 * gate only, see that route's own doc — when the session bootstrap reports `canModerate`; the
 * server's `requireModerator` guard on `reviews.moderationList`/`reject`/`restore` is what
 * actually enforces the capability regardless of whether this screen ever renders.
 *
 * JUDGMENT CALL: the state filter is LOCAL component state, not a URL search param the way S2's
 * catalogue filters are ("the URL is the state" — SPEC-0001's own words for S2, repeated for no
 * other screen). S8 is explicitly "not a queue... a browse-and-act surface", not a linkable result
 * set — nothing in SPEC-0001 asks a filtered moderation view to survive a reload or be shared as a
 * URL, so the search-schema machinery every OTHER filtered screen in this app carries would be
 * unused weight here. Kept simple rather than made consistent with a pattern whose reason does not
 * apply.
 */
export function ModerationScreen() {
  const [state, setState] = useState<ModerationState>('published');
  const filterFieldId = useId();

  const query = useModerationReviews(state);

  // Per-row mutation state, never screen-wide: acting on one row must not disable or blank out
  // every other row (SPEC-0001 S8's "keeps focus on the row so a moderator can act down the list
  // without refinding their place" only holds if the rest of the list stays interactive and
  // visible while one row's reject/restore call is in flight).
  const [pendingTokens, setPendingTokens] = useState<ReadonlySet<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, ApiError>>>({});

  const rejectMutation = useMutation(apiQuery.reviews.reject.mutationOptions());
  const restoreMutation = useMutation(apiQuery.reviews.restore.mutationOptions());

  async function act(
    reviewToken: string,
    mutateAsync: (input: { reviewToken: string }) => Promise<unknown>,
  ): Promise<void> {
    setPendingTokens((prev) => new Set(prev).add(reviewToken));
    setRowErrors((prev) => {
      if (!(reviewToken in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[reviewToken];
      return next;
    });
    try {
      await mutateAsync({ reviewToken });
      // SPEC-0001 S8: "The row updates in place; no navigation." Invalidating the CURRENT state
      // filter only (see `use-moderation-reviews.ts`'s own doc for the full reasoning) rather than
      // patching the acted-on row into the cache by hand: a rejected row dropping out of the
      // `published` list on its next refetch already reads as "updated in place" to the moderator
      // looking at exactly one state at a time, so there is nothing for optimistic list surgery to
      // buy here beyond complexity a reversible, low-stakes action does not need.
      query.invalidate();
    } catch (error) {
      const apiError = toApiError(error);
      // UNAUTHORIZED renders as nothing here, same precedent `product-form-machine.ts`'s `failed`
      // case documents: `shared/errors`' `installUnauthorizedRedirect` is a mutation-cache-wide
      // subscriber that already redirects to `/sign-in` before this branch could show a banner —
      // showing one anyway would just flash before the navigation.
      if (apiError.code !== ERROR_CODE.Unauthorized) {
        setRowErrors((prev) => ({ ...prev, [reviewToken]: apiError }));
      }
    } finally {
      setPendingTokens((prev) => {
        const next = new Set(prev);
        next.delete(reviewToken);
        return next;
      });
    }
  }

  function handleReject(reviewToken: string): void {
    void act(reviewToken, (input) => rejectMutation.mutateAsync(input));
  }

  function handleRestore(reviewToken: string): void {
    void act(reviewToken, (input) => restoreMutation.mutateAsync(input));
  }

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <h1 className="text-display">Moderation</h1>

      {/* A native control, the S8 keyboard contract's own requirement — not a click-handler pair
          of divs. */}
      <div className="flex flex-col gap-1 self-start">
        <Label htmlFor={filterFieldId}>State</Label>
        <select
          id={filterFieldId}
          className="flex h-(--size-touch-target) rounded-control border border-border bg-surface-raised px-(--size-control-inset) text-body text-content shadow-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus-ring)"
          value={state}
          onChange={(event) => setState(event.target.value as ModerationState)}
        >
          {MODERATION_STATES.map((value) => (
            <option key={value} value={value}>
              {STATE_LABEL[value]}
            </option>
          ))}
        </select>
      </div>

      <ModerationList
        query={query}
        pendingTokens={pendingTokens}
        rowErrors={rowErrors}
        onReject={handleReject}
        onRestore={handleRestore}
      />
    </main>
  );
}

interface ModerationListProps {
  readonly query: ReturnType<typeof useModerationReviews>;
  readonly pendingTokens: ReadonlySet<string>;
  readonly rowErrors: Readonly<Record<string, ApiError>>;
  readonly onReject: (reviewToken: string) => void;
  readonly onRestore: (reviewToken: string) => void;
}

/** The list region, scoped loading/empty/error states — the same split
 * `product-detail/review-list.tsx` establishes between a screen and its own list's states. */
function ModerationList({
  query,
  pendingTokens,
  rowErrors,
  onReject,
  onRestore,
}: ModerationListProps) {
  if (query.isLoading) {
    return (
      <ul className="flex flex-col gap-3" aria-busy="true">
        {Array.from({ length: SKELETON_COUNT }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-count skeleton row has no identity of its own to key by.
          <li key={index} className="list-none">
            <div className="h-32 animate-pulse rounded-control bg-surface-sunken" />
          </li>
        ))}
      </ul>
    );
  }

  if (query.isError) {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-3">
          <p role="alert">{errorMessageFor(query.apiError?.code ?? ERROR_CODE.Internal)}</p>
          <Button type="button" onClick={query.refetch}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (query.items.length === 0) {
    return <p>No reviews yet.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-3">
        {query.items.map((review) => (
          <ModerationRow
            key={review.token}
            review={review}
            isPending={pendingTokens.has(review.token)}
            error={rowErrors[review.token]}
            onReject={() => onReject(review.token)}
            onRestore={() => onRestore(review.token)}
          />
        ))}
      </ul>
      {query.hasNextPage && (
        <Button
          type="button"
          variant="outline"
          onClick={query.fetchNextPage}
          disabled={query.isFetchingNextPage}
        >
          {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  );
}
