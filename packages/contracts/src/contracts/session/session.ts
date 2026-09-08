import { oc } from '@orpc/contract';
import { z } from 'zod';

/**
 * The SPA's bootstrap payload (ADR-0006): everything a freshly-loaded client needs about *this*
 * session, in one request, so the router's guards can decide before the first screen paints.
 *
 * Only a PUBLIC token crosses this boundary: `auth.app_user.token`. The internal `app_user_id`
 * uuid stays server-side — the client has no use for it, and an id it never sees is one it can
 * never leak.
 */
export const sessionBootstrapSchema = z.object({
  userToken: z.string().regex(/^usr_[0-9A-Za-z]{21}$/),
  /**
   * Whether this user has finished onboarding — the fact a router-level onboarding guard
   * redirects on. A boolean rather than a richer progress shape on purpose: the guard's only
   * question is "send this session to `/onboarding` or not", and a wire field exists to answer
   * exactly the question that is asked.
   */
  onboardingComplete: z.boolean(),
});
export type SessionBootstrap = z.infer<typeof sessionBootstrapSchema>;

/**
 * The session-scoped contract the SPA calls on load. Session-required like every other route: an
 * anonymous call returns the uniform 401 wire shape, which is exactly what the SPA's router-level
 * 401 handler redirects on — the unauthenticated path is a normal, typed answer here, not an
 * exception.
 */
export const sessionContract = oc.router({
  bootstrap: oc.route({ method: 'GET', path: '/session/bootstrap' }).output(sessionBootstrapSchema),
});
