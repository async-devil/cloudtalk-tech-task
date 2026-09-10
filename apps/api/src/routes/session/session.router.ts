import { implement } from '@orpc/server';
import { requireSession } from '@repo/auth';
import type { SessionBootstrap } from '@repo/contracts';
import { appContract } from '@repo/contracts';
import { type HttpRequestContext, toOrpcError } from '../../http/error-mapper.js';

/**
 * Whether this session's user has finished onboarding — the fact the SPA's onboarding guard
 * redirects on.
 *
 * **This repository has no onboarding data model, and inventing one here would be inventing
 * product semantics.** So this is the seam, not the feature: it is the one function a product
 * replaces (with a column read, a checklist projection, whatever it actually means there), and it
 * returns `true` — "nothing to onboard" — until it is replaced.
 */
function isOnboardingComplete(): boolean {
  return true;
}

/**
 * Implements `appContract.session`: the SPA's one bootstrap call.
 *
 * Session-required like every other route — and the 401 an anonymous caller gets is not an edge
 * case here but the SPA's normal "not signed in" answer, which its router-level 401 handler turns
 * into the sign-in redirect.
 *
 * Only the public token leaves: `session.userToken`. The internal `userId` never appears in the
 * response (ADR-0013). `canManageCatalogue` carries `session.catalogueManager` under its
 * deliberately different wire name (TASK-0008, SPEC-0003) — an affordance the SPA renders on, never
 * the authorization itself; `products.create`/`products.update` are what actually enforce it.
 * `canModerate` carries `session.moderator` the same way (TASK-0009): `reviews.moderationList`/
 * `reject`/`restore` are what actually enforce that one.
 */
export function createSessionRouter() {
  const impl = implement<typeof appContract.session, HttpRequestContext>(appContract.session);

  return impl.router({
    // Not `async`: nothing here awaits, and oRPC accepts a synchronous return. Marking it
    // async would only add a microtask and trip `useAwait`.
    bootstrap: impl.bootstrap.handler(({ context }) => {
      try {
        const session = requireSession(context);
        const payload: SessionBootstrap = {
          userToken: session.userToken,
          onboardingComplete: isOnboardingComplete(),
          canManageCatalogue: session.catalogueManager,
          canModerate: session.moderator,
        };
        return payload;
      } catch (error) {
        throw toOrpcError(error, context);
      }
    }),
  });
}
