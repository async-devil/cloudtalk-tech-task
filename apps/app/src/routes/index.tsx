import { createFileRoute } from '@tanstack/react-router';
import { CatalogueScreen } from '../features/catalogue/catalogue-screen.js';
import { catalogueSearchSchema } from '../features/catalogue/catalogue-search.js';

/**
 * The catalogue (SPEC-0001 S2), replacing the earlier signed-in-only placeholder. Public
 * (`__root.tsx`'s `PUBLIC_ROUTES` — SPEC-0001 J1: browsing costs no session at any point).
 */
export const Route = createFileRoute('/')({
  validateSearch: catalogueSearchSchema,
  component: HomeRoute,
});

/**
 * A ROUTE MODULE: extracts the validated search params and composes the feature, owning nothing
 * itself (the `sign-in.tsx` convention). `onSearchChange` is the one piece of router behaviour the
 * slice cannot have directly (`features/` may not import `routes/`) — a merge-and-navigate,
 * `replace: true` so debounced keystrokes do not pile up the browser's back button one entry per
 * commit.
 */
function HomeRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <CatalogueScreen
      search={search}
      onSearchChange={(patch) => {
        void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });
      }}
    />
  );
}
