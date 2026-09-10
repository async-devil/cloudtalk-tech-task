import { ERROR_CODE } from '@repo/kernel';
import { Button, Card, CardContent, Label } from '@repo/styles';
import { useEffect, useId, useState } from 'react';
import { errorMessageFor } from '../../shared/errors/index.js';
import { useSession } from '../../shared/session/index.js';
import {
  CATALOGUE_SORTS,
  type CatalogueSearch,
  type CatalogueSort,
  filtersFromSearch,
  hasActiveFilter,
} from './catalogue-search.js';
import { ProductCard, ProductCardSkeleton } from './product-card.js';
import { useCatalogueProducts } from './use-catalogue-products.js';

const SEARCH_DEBOUNCE_MS = 300;
const SKELETON_COUNT = 6;

export interface CatalogueScreenProps {
  readonly search: CatalogueSearch;
  /** Merges `patch` into the current URL search state — the route owns navigation
   * (`routes/index.tsx`), this slice only ever asks for a patch (ADR-0012: a feature never
   * imports a route). */
  readonly onSearchChange: (patch: Partial<CatalogueSearch>) => void;
}

/**
 * The catalogue (SPEC-0001 S2), replacing the placeholder `/` route.
 *
 * "The URL is the state": every control below reads its current value from `search` (the route's
 * validated search params) and writes back through `onSearchChange` — nothing about the active
 * filter lives in local-only React state the URL does not also carry. The two text fields debounce
 * their OWN keystrokes (`useDebouncedField` below) so a URL replace does not fire on every
 * keypress; the committed value after the debounce is what reaches `onSearchChange`.
 */
export function CatalogueScreen({ search, onSearchChange }: CatalogueScreenProps) {
  const filters = filtersFromSearch(search);
  const query = useCatalogueProducts(filters);
  const filterActive = hasActiveFilter(filters);
  // Visitor surface (rule 15) — this reads only to show a minimal "signed in" line; nothing on
  // this screen is gated by it (no manager affordance in this wave, TASK-0008's own scope line).
  const session = useSession();
  const searchFieldId = useId();
  const categoryFieldId = useId();
  const sortFieldId = useId();

  const [queryDraft, setQueryDraft] = useDebouncedField(
    filters.query,
    (next) => onSearchChange({ query: next }),
    SEARCH_DEBOUNCE_MS,
  );
  const [categoryDraft, setCategoryDraft] = useDebouncedField(
    filters.category,
    (next) => onSearchChange({ category: next }),
    SEARCH_DEBOUNCE_MS,
  );

  function clearFilters(): void {
    setQueryDraft('');
    setCategoryDraft('');
    onSearchChange({ query: undefined, category: undefined });
  }

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-display">Catalogue</h1>
        {session !== undefined && (
          <p className="text-caption text-content-muted" data-testid="session-user-token">
            Signed in as {session.userToken}
          </p>
        )}
      </div>

      {/* Native form controls only — no click-handler on a div (SPEC-0001 S2's keyboard contract).
          No `onSubmit`: every field commits through its own change/debounce, so there is nothing
          for a submit to do — Enter in the search box just stops producing new keystrokes. */}
      <form className="flex flex-wrap items-end gap-3" aria-label="Filter the catalogue">
        <div className="flex flex-col gap-1">
          <Label htmlFor={searchFieldId}>Search</Label>
          <input
            id={searchFieldId}
            type="search"
            className="flex h-(--size-touch-target) w-56 rounded-control border border-border bg-surface-raised px-(--size-control-inset) text-body text-content shadow-raised placeholder:text-content-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus-ring)"
            placeholder="Product name or SKU"
            value={queryDraft}
            onChange={(event) => setQueryDraft(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={categoryFieldId}>Category</Label>
          <input
            id={categoryFieldId}
            type="text"
            className="flex h-(--size-touch-target) w-40 rounded-control border border-border bg-surface-raised px-(--size-control-inset) text-body text-content shadow-raised placeholder:text-content-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus-ring)"
            placeholder="e.g. Audio"
            value={categoryDraft}
            onChange={(event) => setCategoryDraft(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={sortFieldId}>Sort</Label>
          <select
            id={sortFieldId}
            className="flex h-(--size-touch-target) rounded-control border border-border bg-surface-raised px-(--size-control-inset) text-body text-content shadow-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus-ring)"
            value={search.sort}
            onChange={(event) => onSearchChange({ sort: event.target.value as CatalogueSort })}
          >
            {CATALOGUE_SORTS.map((sort) => (
              <option key={sort} value={sort}>
                {SORT_LABEL[sort]}
              </option>
            ))}
          </select>
        </div>
        {filterActive && (
          <Button type="button" variant="outline" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      </form>

      <CatalogueResults
        query={query}
        filterActive={filterActive}
        search={search}
        onClear={clearFilters}
      />
    </main>
  );
}

const SORT_LABEL: Record<CatalogueSort, string> = {
  rating: 'Highest rated',
  recent: 'Most recent',
  name: 'Name',
};

interface CatalogueResultsProps {
  readonly query: ReturnType<typeof useCatalogueProducts>;
  readonly filterActive: boolean;
  readonly search: CatalogueSearch;
  readonly onClear: () => void;
}

function CatalogueResults({ query, filterActive, search, onClear }: CatalogueResultsProps) {
  if (query.isLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3" aria-busy="true">
        {Array.from({ length: SKELETON_COUNT }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-count skeleton row has no identity of its own — every entry is interchangeable placeholder chrome.
          <ProductCardSkeleton key={index} />
        ))}
      </div>
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
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-3">
          {filterActive ? (
            <>
              <p>
                No products match
                {search.query !== undefined && <> “{search.query}”</>}
                {search.category !== undefined && <> in “{search.category}”</>}.
              </p>
              <Button type="button" variant="outline" onClick={onClear}>
                Clear filters
              </Button>
            </>
          ) : (
            <p>No products in the catalogue yet.</p>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
        {query.items.map((product) => (
          <ProductCard key={product.slug} product={product} />
        ))}
      </div>
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

/**
 * A local text field committer: keeps a draft in state for instant typing feedback, and calls
 * `commit` only after `delayMs` of no further keystrokes — the debounce SPEC-0001 S2 asks for on
 * the search box, applied identically to the category field. Re-syncs the draft from `committed`
 * when it changes from OUTSIDE this field (browser back/forward, "Clear filters"), never on every
 * render.
 */
function useDebouncedField(
  committed: string | undefined,
  commit: (next: string | undefined) => void,
  delayMs: number,
): [string, (next: string) => void] {
  const [draft, setDraft] = useState(committed ?? '');

  // Re-syncs ONLY when the externally-committed value changes, never when `draft` itself changes
  // (that asymmetry is this function's whole point) — `committed` is this effect's one real
  // dependency, so there is nothing here for `useExhaustiveDependencies` to flag.
  useEffect(() => {
    setDraft(committed ?? '');
  }, [committed]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `commit` is deliberately excluded — it is a fresh closure every render (it captures `onSearchChange`, itself stable only across the parent's own renders), and including it would reset the debounce timer on every parent re-render, defeating the debounce. `draft`/`committed`/`delayMs` are the values that should restart the timer.
  useEffect(() => {
    const trimmed = draft.trim();
    const next = trimmed === '' ? undefined : trimmed;
    if (next === (committed ?? undefined)) {
      return;
    }
    const timer = setTimeout(() => {
      commit(next);
    }, delayMs);
    return () => clearTimeout(timer);
  }, [draft, committed, delayMs]);

  return [draft, setDraft];
}
