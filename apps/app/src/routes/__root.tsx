import type { SessionBootstrap } from '@repo/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, Outlet, redirect } from '@tanstack/react-router';
import { loadSessionBootstrap } from '../shared/session/index.js';

/** What every route (and every guard) is given. The query client is the app's ONE server-state
 * cache, so a guard's `ensureQueryData` and a component's `useQuery` share it — the bootstrap is
 * fetched once per navigation burst, not once per consumer. */
export interface RouterContext {
  readonly queryClient: QueryClient;
}

export const SIGN_IN_ROUTE = '/sign-in';

/**
 * The ONE list of routes reachable without a session. One const, beside the guard, so "is this
 * page public?" has a single answer that a reviewer can read in full — a per-route `public: true`
 * flag scattered across files is how a route becomes accidentally public.
 *
 * Auth callback paths are here because the user arrives on them BY DEFINITION without a session
 * (that is what they are for); sending them to `/sign-in` would break the magic-link flow.
 */
export const PUBLIC_ROUTES: readonly string[] = [SIGN_IN_ROUTE, '/auth/callback'];

/** Prefix matching, not equality: `/auth/callback/magic-link` is the same public surface. The
 * `/` guard on the prefix keeps `/sign-in-somewhere-else` from matching `/sign-in`. */
export function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

/** Where the guard sends the request, or `undefined` to let it through. */
export type GuardRedirect = {
  readonly to: typeof SIGN_IN_ROUTE;
  readonly search: { readonly returnTo: string };
};

export interface GuardInput {
  readonly pathname: string;
  /** The attempted location (path + search), preserved so sign-in can return the user to it. */
  readonly returnTo: string;
  /** `undefined` ⇒ no session (the api answered 401). */
  readonly bootstrap: SessionBootstrap | undefined;
}

/**
 * The root guard, as a pure function: no session ⇒ `/sign-in`, carrying the attempted location.
 *
 * Pure and exported because a redirect that silently stops happening is invisible: `beforeLoad`
 * below is a two-line adapter over this, and `test/root-guards.test.tsx` drives both this
 * function and a real router navigation.
 */
export function guardRedirectFor(input: GuardInput): GuardRedirect | undefined {
  if (input.bootstrap === undefined) {
    return { to: SIGN_IN_ROUTE, search: { returnTo: input.returnTo } };
  }
  return undefined;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context, location }) => {
    if (isPublicRoute(location.pathname)) {
      return;
    }
    const bootstrap = await loadSessionBootstrap(context.queryClient);
    const target = guardRedirectFor({
      pathname: location.pathname,
      returnTo: location.href,
      bootstrap,
    });
    if (target !== undefined) {
      throw redirect(target);
    }
  },
  component: RootLayout,
});

/**
 * The app's outermost chrome.
 *
 * The `*-safe-*` utilities are `@repo/styles`' `--spacing-safe-*` tokens: on a notched device they
 * resolve to the viewport's inset, and everywhere else to the `0px` fallback the tokens declare —
 * so this is one class list, not a platform branch.
 *
 * Padding rather than margin, on the element that also carries `min-h-dvh`: Tailwind's preflight
 * sets `box-sizing: border-box` globally, so the insets eat into the viewport height instead of
 * adding to it, and the page does not gain a scrollbar on a notched device.
 */
function RootLayout() {
  return (
    <div className="min-h-dvh bg-surface pt-(--spacing-safe-top) pr-(--spacing-safe-right) pb-(--spacing-safe-bottom) pl-(--spacing-safe-left) text-content">
      <Outlet />
    </div>
  );
}
