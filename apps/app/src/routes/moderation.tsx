import { createFileRoute, redirect } from '@tanstack/react-router';
import { ModerationScreen } from '../features/moderation/moderation-screen.js';
import { loadSessionBootstrap } from '../shared/session/index.js';

/**
 * S8 — review moderation (SPEC-0001, TASK-0009). `/moderation` is NOT in `__root.tsx`'s
 * `PUBLIC_ROUTES`, so an anonymous visitor is already bounced to `/sign-in` by the root guard
 * before this file's own `beforeLoad` ever runs — the same two-guard shape
 * `routes/products/new.tsx` documents. This `beforeLoad` is the SECOND, ADDITIVE check the root
 * guard cannot make on its own (it has no notion of capabilities): a signed-in session that lacks
 * `canModerate` is redirected to the catalogue, mirroring SPEC-0001's own words for S8 — "a
 * visitor who types the URL gets the same treatment as S7 — redirected, and refused server-side
 * regardless."
 *
 * COURTESY GATE ONLY. `reviews.moderationList`/`reject`/`restore`'s own `requireModerator` guard
 * (`@repo/auth`, enforced at the HTTP boundary) is what actually refuses those calls regardless of
 * what this redirect does or does not do — `moderation-screen.tsx` never second-guesses a 403 it
 * might receive anyway, the same `product-form.tsx` precedent.
 */
export const Route = createFileRoute('/moderation')({
  beforeLoad: async ({ context }) => {
    const bootstrap = await loadSessionBootstrap(context.queryClient);
    if (bootstrap === undefined || bootstrap.canModerate !== true) {
      throw redirect({ to: '/' });
    }
  },
  component: ModerationScreen,
});
