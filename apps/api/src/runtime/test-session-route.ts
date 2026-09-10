import { APP_MODE, type AppMode } from '@repo/config';
import { type Kysely, sql } from 'kysely';

/**
 * ============================================================================================
 * THE E2E SESSION-MOCK ROUTE — AN AUTHENTICATION BYPASS, BY DESIGN.
 * ============================================================================================
 *
 * An end-to-end suite needs an authenticated browser context for nearly every spec. Driving the
 * real magic-link flow per test costs a mail round-trip and a second page load each time, so this
 * repository sanctions ONE test-only route that mints a real better-auth session for a seeded
 * address in a single call (one spec still drives the real flow end to end — that is what proves
 * the real flow).
 *
 * What makes it safe is that in `staging`/`production` **this route does not exist**: it is never
 * registered, because {@link mountTestSessionRoute} is called only under `mode === 'test'` and
 * refuses outright otherwise. That is deliberately NOT "the handler checks the mode and 403s" —
 * a handler that exists can be reached by a routing bug, a mount-order change, or a proxy rewrite;
 * a route that was never constructed cannot. `apps/api/test/test-session-route.test.ts` builds the
 * app in `production` and asserts the path 404s, and drives the refusal below directly.
 *
 * It mints a REAL session (the same two-request magic-link flow a user performs), not a forged
 * cookie: an e2e is then exercising the real session middleware and the real session resolution —
 * a hand-rolled cookie would prove none of that.
 *
 * TASK-0008 extends the POST body with an optional `catalogueManager: boolean` — a small,
 * test-mode-only shortcut for granting the `catalogue_manager` capability to the session just
 * minted, so a Playwright spec can act as a manager without a seeded row (TASK-0006 seed data does
 * not exist for this catalogue-authoring spec to depend on). It rides the SAME structural lock as
 * everything else in this file: the grant is a plain `UPDATE auth.app_user` scoped to the address
 * just signed in, reachable only because this whole route is reachable only in `test` mode.
 */

/** The one path this route occupies. Namespaced under `/api/test/` so it is unmistakable in a
 * request log, and matched by an EXACT path — no wildcard that could swallow a sibling. */
export const TEST_SESSION_ROUTE_PATH = '/api/test/session';

/**
 * The second test-only path, under the same lock and for the same reason (one test DOES drive the
 * real flow end to end).
 *
 * WHY IT HAS TO EXIST. The magic link is only ever delivered to the dev mail sender's in-memory
 * capture, inside this process. `TEST_SESSION_ROUTE_PATH` above reads that capture in-process and
 * hands back a cookie, which is precisely what makes it a SHORTCUT — it proves nothing about the
 * screen a user actually uses. An out-of-process e2e test driving the real sign-in form has no way
 * to reach the link, so before this route the real-flow spec was unwritable and the session-mock
 * stood in for something nothing verified.
 *
 * It returns the link, never a session: following it is the browser's job, which is the whole
 * point. Same `test`-mode-only construction as its sibling — see this file's header.
 */
export const TEST_LAST_MAGIC_LINK_ROUTE_PATH = '/api/test/last-magic-link';

/**
 * The query parameter naming WHOSE link the caller wants — required, not optional.
 *
 * THE RACE THIS EXISTS TO REMOVE. Both routes in this file could read "the most recently sent
 * mail" — one global slot — with both callers address-blind by construction: the mailbox holds
 * every message the process has ever sent, and a parallel e2e run can drive two authenticated
 * contexts at once. Two consequences, and the second is worse than the flake that would expose
 * the first:
 *
 *  1. Two specs running concurrently each submit a link for their own unique address, then both
 *     read the slot — and whichever reads second could get the other's URL. A magic-link token is
 *     SINGLE USE, so one browser consumed it and the other got a dead token, no session, and a
 *     guard redirect to sign-in.
 *  2. `TEST_SESSION_ROUTE_PATH` sends a magic link and then reads the same slot. Any concurrent
 *     send — from another spec's own session mint, or from the real-flow spec — could land in
 *     between, so `authenticate('a@example.test')` could mint a session for `b@example.test` and
 *     report success. Silently. Every spec in the suite depends on that call being correct.
 *
 * Scoping the lookup to a recipient removes both BY CONSTRUCTION rather than by retry, timeout or
 * worker-count tuning: each caller already knows the address it wants, so there is nothing left to
 * race over.
 */
export const MAGIC_LINK_EMAIL_QUERY_PARAMETER = 'email';

/** What the composition root injects (only in `test` mode — `runtime/main.ts`). */
export interface TestSessionMockDependencies {
  /** better-auth's fetch handler — the same one `/api/auth/*` is mounted on. */
  readonly authHandler: (request: Request) => Promise<Response>;
  /** The absolute origin magic links are minted against (`AUTH_BASE_URL`). */
  readonly authBaseUrl: string;
  /**
   * Reads the plain-text body of the most recent mail sent TO `email` — the dev mail sender's
   * capture (`runtime/mail-sender.ts`'s `createDevMailSender`). A seam, not an import: this file
   * must not know which `MailSenderPort` implementation the root wired.
   *
   * ADDRESSED, not "the last one" — see {@link MAGIC_LINK_EMAIL_QUERY_PARAMETER} for the two races
   * that shape cost. Most-recent-for-that-address rather than first: a spec that requests a second
   * link for the same address wants the live token, and an earlier one may already be consumed.
   */
  readonly readLastSentMailTextFor: (email: string) => string | undefined;
  /**
   * The SAME pool the composition root hands `HttpHandlerDeps.db` (TASK-0008) — needed for the
   * `catalogueManager` capability grant below. `Kysely<unknown>`, same as every other capability
   * module's own handle: this route owns no schema of its own and reaches straight into
   * `auth.app_user`/`auth.identity`, exactly as `@repo/auth`'s own `resolveRequestSession` does.
   */
  readonly db: Kysely<unknown>;
}

/** The minimum of Elysia's surface this route needs; keeping it structural means this module
 * imports no framework, so it can be unit-tested with a two-line fake. */
export interface RouteRegistrar {
  all(
    path: string,
    handler: (context: { readonly request: Request }) => Promise<Response>,
  ): unknown;
}

function extractUrl(text: string): string | undefined {
  return /https?:\/\/\S+/.exec(text)?.[0];
}

/**
 * Registers {@link TEST_SESSION_ROUTE_PATH} on `app`.
 *
 * @throws Error when `mode` is anything but `test`. The caller already guards on mode; this is the
 * second lock on the same door, and the one a future refactor of the caller cannot silently
 * remove.
 */
export function mountTestSessionRoute(
  app: RouteRegistrar,
  mode: AppMode,
  deps: TestSessionMockDependencies,
): void {
  if (mode !== APP_MODE.Test) {
    throw new Error(
      `refusing to mount ${TEST_SESSION_ROUTE_PATH}: it mints a session for any address given to ` +
        `it, so it exists in APP_MODE=test only (got "${mode}")`,
    );
  }

  // Reads the dev sender's capture. Guarded by the SAME refusal above — deliberately mounted from
  // inside this function rather than exported as its own `mountX`, so there is exactly one door
  // and exactly one lock to reason about. A caller cannot mount this one and forget the check.
  app.all(TEST_LAST_MAGIC_LINK_ROUTE_PATH, ({ request }) => {
    if (request.method !== 'GET') {
      return Promise.resolve(new Response(null, { status: 405 }));
    }
    // REQUIRED, and a 400 rather than a fallback to "the last mail": falling back is exactly the
    // behaviour that produces a cross-request race, and a silent fallback would let a caller that
    // forgot the parameter re-introduce it without noticing.
    const email = new URL(request.url).searchParams.get(MAGIC_LINK_EMAIL_QUERY_PARAMETER);
    if (email === null || email === '') {
      return Promise.resolve(
        Response.json(
          { error: `${MAGIC_LINK_EMAIL_QUERY_PARAMETER} query parameter is required` },
          { status: 400 },
        ),
      );
    }
    const text = deps.readLastSentMailTextFor(email);
    const url = text === undefined ? undefined : extractUrl(text);
    if (url === undefined) {
      return Promise.resolve(
        Response.json({ error: `no magic-link mail was captured for ${email}` }, { status: 404 }),
      );
    }
    return Promise.resolve(Response.json({ url }));
  });

  app.all(TEST_SESSION_ROUTE_PATH, async ({ request }) => {
    if (request.method !== 'POST') {
      return new Response(null, { status: 405 });
    }
    const body = (await request.json()) as {
      readonly email?: unknown;
      readonly catalogueManager?: unknown;
    };
    if (typeof body.email !== 'string' || body.email === '') {
      return Response.json({ error: 'email is required' }, { status: 400 });
    }
    const email = body.email;

    // Step 1: ask better-auth to send a magic link, exactly as the sign-in screen does.
    const signIn = await deps.authHandler(
      new Request(`${deps.authBaseUrl}/api/auth/sign-in/magic-link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: deps.authBaseUrl },
        body: JSON.stringify({ email }),
      }),
    );
    if (signIn.status !== 200) {
      return Response.json(
        { error: `sign-in/magic-link returned ${signIn.status}` },
        { status: 502 },
      );
    }

    // Step 2: follow the link out of the dev sender's capture — the same URL a human clicks.
    // Scoped to the address this call just sent to, so a concurrent send from another spec cannot
    // hand this caller someone else's link (see MAGIC_LINK_EMAIL_QUERY_PARAMETER).
    const text = deps.readLastSentMailTextFor(email);
    const verifyUrl = text === undefined ? undefined : extractUrl(text);
    if (verifyUrl === undefined) {
      return Response.json({ error: 'no magic-link mail was captured' }, { status: 502 });
    }
    const verify = await deps.authHandler(new Request(verifyUrl, { method: 'GET' }));

    // Step 3: hand the browser the session cookie better-auth just set. Nothing is re-signed or
    // re-derived here — the cookie is passed through verbatim, so it is a real session or nothing.
    const setCookies = verify.headers.getSetCookie();
    if (setCookies.length === 0) {
      return Response.json(
        { error: `magic-link verify set no session cookie (status ${verify.status})` },
        { status: 502 },
      );
    }

    // Step 4 (TASK-0008, optional): grant `catalogue_manager` to the identity just signed in. A
    // real Postgres row exists by now — the session-create hook creates `auth.app_user` during
    // Step 2's verify — so this can address it directly by the email this whole request already
    // authenticated. Strictly `=== true`: omitted, `false`, or any other value leaves the row
    // untouched (a fail-closed reading, matching ADR-0011's stance on booleans generally) rather
    // than treating anything truthy as a grant.
    if (body.catalogueManager === true) {
      await sql`
        UPDATE auth.app_user SET catalogue_manager = true
        WHERE identity_id = (SELECT id FROM auth.identity WHERE email = ${email})
      `.execute(deps.db);
    }

    const headers = new Headers();
    for (const cookie of setCookies) {
      headers.append('set-cookie', cookie);
    }
    return new Response(null, { status: 204, headers });
  });
}
