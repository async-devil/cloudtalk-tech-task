import { Card, CardContent } from '@repo/styles';
import type { QueryClient } from '@tanstack/react-query';
import { createRouter, type ErrorComponentProps, type RouterHistory } from '@tanstack/react-router';
import { useEffect } from 'react';
import { SIGN_IN_ROUTE } from './routes/__root.js';
import { routeTree } from './routeTree.gen.js';
import { errorMessageFor, installUnauthorizedRedirect, toApiError } from './shared/errors/index.js';
import { observability } from './shared/observability/index.js';

export interface CreateAppRouterOptions {
  readonly queryClient: QueryClient;
  /** Injected by tests (a memory history); the browser history is the default. */
  readonly history?: RouterHistory;
}

/**
 * Builds the router from the GENERATED route tree. `routeTree.gen.ts` is produced by `tsr
 * generate` (`moon run app:route-tree`), committed, and re-checked in CI (`app:route-tree-check`)
 * — a hand-edited tree that drifts from `src/routes/` is the failure this codegen pair exists to
 * make impossible.
 *
 * The query client rides in the router CONTEXT rather than being imported by the guards, so a
 * test can drive real navigations against a cache it controls, and so the guards' data access is
 * the app's one Query cache instead of a second, invisible one.
 */
export function createAppRouter(options: CreateAppRouterOptions) {
  const router = createRouter({
    routeTree,
    context: { queryClient: options.queryClient },
    defaultPreload: 'intent',
    /**
     * The app's ONE error boundary, and the only caller of `observability.reportError`
     * (ADR-0008's "handled once, at a boundary" in its frontend form).
     *
     * It exists because the wrapper did not have one on its own: a route loader that threw would
     * otherwise render TanStack's default error component and the failure would go unreported. A
     * boundary with no caller is a claim, not a boundary.
     *
     * 401 is deliberately NOT special-cased here: it never arrives, because the Query cache-level
     * subscriber below turns it into a redirect before a route can fail on it.
     */
    defaultErrorComponent: DefaultErrorComponent,
    ...(options.history !== undefined ? { history: options.history } : {}),
  });

  /**
   * The 401 handler, installed ONCE, here. This is the router level: it is the only layer that
   * can navigate, and putting it anywhere else would mean every feature re-deciding what a 401
   * means. `returnTo` is the location the user was on when the session expired, so signing back in
   * resumes rather than restarts.
   */
  installUnauthorizedRedirect(options.queryClient, (returnTo) => {
    void router.navigate({ to: SIGN_IN_ROUTE, search: { returnTo }, replace: true });
  });

  return router;
}

/**
 * What a user sees when a route fails, and the one place a failure is reported.
 *
 * The copy is `ApiError`-derived registered message text (`shared/errors`' `errorMessageFor`) —
 * an error screen is the LAST place to render an untranslated literal, because it is the screen a
 * user is most likely to be reading in anger.
 */
function DefaultErrorComponent({ error }: ErrorComponentProps) {
  // Reporting lives in an effect keyed on the error, NOT in the render body. A render-body call
  // fires again on every re-render — measured at 4 reports for a single failed navigation
  // (`test/router-error-boundary.test.tsx` caught exactly this) — which turns one outage into a
  // flood of duplicates at whatever provider a product wires, and makes the report count a
  // function of React's scheduling rather than of how many things broke.
  useEffect(() => {
    observability.reportError(error, { boundary: 'router' });
  }, [error]);

  const apiError = toApiError(error);
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <Card>
        <CardContent>
          <p role="alert" data-testid="route-error">
            {errorMessageFor(apiError.code)}
          </p>
        </CardContent>
      </Card>
    </main>
  );
}

export type AppRouter = ReturnType<typeof createAppRouter>;

/** Registers the router's types globally, which is what makes `<Link to="…">`, `useSearch()` and
 * `redirect({ to })` type-checked against the real route tree rather than plain strings. */
declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
