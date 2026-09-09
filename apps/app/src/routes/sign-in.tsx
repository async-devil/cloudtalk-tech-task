import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { SignInScreen } from '../features/sign-in/sign-in-screen.js';

/**
 * `returnTo` — where the user was headed when the session guard bounced them here.
 *
 * **Validated as a same-origin PATH, never a URL.** This value arrives in the query string, so an
 * attacker controls it; echoing it into a post-sign-in navigation unvalidated is a textbook open
 * redirect (`/sign-in?returnTo=https://evil.example`), and one that lands the user there *after*
 * authenticating. A leading `/` that is not `//` (protocol-relative) is exactly the set of
 * in-app destinations.
 *
 * `catch` rather than `throw`: a malformed `returnTo` must degrade to "go home", not blank the
 * sign-in screen with a validation error — the user's actual goal is to sign in.
 */
const signInSearchSchema = z.object({
  returnTo: z
    .string()
    .refine((value) => value.startsWith('/') && !value.startsWith('//'), {
      message: 'returnTo must be an in-app path',
    })
    .catch('/')
    .default('/'),
});

export const Route = createFileRoute('/sign-in')({
  validateSearch: signInSearchSchema,
  component: SignInRoute,
});

/**
 * A ROUTE MODULE: composes the feature and owns nothing. The URL is the router's concern and lives
 * here; the flow is the slice's.
 */
function SignInRoute() {
  const { returnTo } = Route.useSearch();
  return <SignInScreen returnTo={returnTo} />;
}
