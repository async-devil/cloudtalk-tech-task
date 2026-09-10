/**
 * THE AUTHENTICATION-BYPASS PROOF.
 *
 * `/api/test/session` mints a real better-auth session for whatever address is posted to it. That
 * is exactly what e2e needs and exactly what must never exist in a deployed environment, so the
 * property under test is STRUCTURAL absence, not a runtime refusal: in `staging`/`production` the
 * route is never registered at all.
 *
 * Two independent locks are proven separately, because a suite that only proved one would pass
 * with the other silently removed:
 *   1. `buildApp` registers the route only under `mode === 'test'` — proven by building the app in
 *      `production` WITH the session-mock deps supplied and asserting the path 404s.
 *   2. `mountTestSessionRoute` itself refuses a non-test mode — proven by calling it directly.
 */
import { APP_MODE } from '@repo/config';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/runtime/build-app.js';
import {
  MAGIC_LINK_EMAIL_QUERY_PARAMETER,
  mountTestSessionRoute,
  TEST_LAST_MAGIC_LINK_ROUTE_PATH,
  TEST_SESSION_ROUTE_PATH,
  type TestSessionMockDependencies,
} from '../src/runtime/test-session-route.js';
import { fakePostgresDb } from './harness/fake-postgres.js';

/**
 * A fake better-auth wiring that WOULD mint a cookie if it were ever reached. The point of the
 * absence tests is that it never is — so `authHandler` throwing on call would be the weaker
 * assertion (a route that exists but errors is still a route). It succeeds instead, which means
 * only a genuinely unregistered path can produce the expected 404.
 */
function workingSessionMock(
  overrides: Partial<TestSessionMockDependencies> = {},
): TestSessionMockDependencies {
  return {
    authHandler: (request) =>
      Promise.resolve(
        request.method === 'POST'
          ? Response.json({ status: true })
          : new Response(null, {
              status: 302,
              headers: { 'set-cookie': 'better-auth.session_token=minted; Path=/; HttpOnly' },
            }),
      ),
    authBaseUrl: 'http://localhost:3000',
    readLastSentMailTextFor: (email) => MAILBOX.filter((m) => m.to === email).at(-1)?.text,
    db: fakePostgresDb(() => ({ rows: [] })),
    ...overrides,
  };
}

/**
 * A mailbox with TWO recipients and an INTERLEAVED order — the shape that makes the address-scoped
 * lookup provable (2026-07-30).
 *
 * The ordering is the point: `b@` is last overall, and `a@` has two entries. A lookup that reads
 * "the most recent message" returns `b@`'s token for every caller, which is the production bug this
 * fixture reproduces; a lookup that reads "the first for this address" returns `a@`'s STALE token,
 * which is the other way to get it wrong (magic-link tokens are single use, so the stale one is
 * dead). Only last-for-that-address satisfies both assertions below.
 */
/** The address {@link sessionRequest} asks for a session as. Named, and present in {@link MAILBOX}
 * below, because the session-mock route now looks its own mail up BY RECIPIENT — a mailbox that does
 * not contain this address makes that route 502, which is the fixture being wrong rather than the
 * route. */
const SESSION_MOCK_EMAIL = 'e2e@example.test';

const MAILBOX: readonly { readonly to: string; readonly text: string }[] = [
  {
    to: SESSION_MOCK_EMAIL,
    text: 'Sign in: http://localhost:3000/api/auth/magic-link/verify?token=e2e',
  },
  {
    to: 'a@example.test',
    text: 'Sign in: http://localhost:3000/api/auth/magic-link/verify?token=a-stale',
  },
  {
    to: 'a@example.test',
    text: 'Sign in: http://localhost:3000/api/auth/magic-link/verify?token=a-live',
  },
  {
    to: 'b@example.test',
    text: 'Sign in: http://localhost:3000/api/auth/magic-link/verify?token=b-live',
  },
];

function sessionRequest(): Request {
  return new Request(`http://localhost${TEST_SESSION_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: SESSION_MOCK_EMAIL }),
  });
}

describe('the e2e session-mock route is absent outside test mode', () => {
  for (const mode of [APP_MODE.Production, APP_MODE.Staging] as const) {
    it(`is not registered in APP_MODE=${mode}, even when its dependencies are supplied`, async () => {
      const app = buildApp({
        mode,
        sessionMock: workingSessionMock(),
      });

      const response = await app.handle(sessionRequest());

      expect(response.status).toBe(404);
      // …and it 404s as the uniform unmatched-route shape, i.e. it fell through to the oRPC
      // mount — no handler of any kind claimed the path.
      expect(await response.json()).toEqual({ code: 'NOT_FOUND', message: 'Not Found' });
    });
  }

  it('IS registered in APP_MODE=test and hands back the minted session cookie', async () => {
    const app = buildApp({
      mode: APP_MODE.Test,
      sessionMock: workingSessionMock(),
    });

    const response = await app.handle(sessionRequest());

    expect(response.status).toBe(204);
    expect(response.headers.getSetCookie().join('; ')).toContain('better-auth.session_token=');
  });

  it('is not registered in test mode either when no session-mock wiring is supplied', async () => {
    const app = buildApp({ ...{}, mode: APP_MODE.Test });

    const response = await app.handle(sessionRequest());

    expect(response.status).toBe(404);
  });

  /**
   * The magic-link reader rides the SAME lock, so it gets the same absence proof rather than
   * inheriting one by association. It exposes a live sign-in credential to anyone who asks — a
   * strictly worse thing to leak than the session route beside it, since it needs no request body
   * at all — so "it is mounted from inside the guarded function" is an argument, and this is the
   * evidence.
   */
  for (const mode of [APP_MODE.Production, APP_MODE.Staging] as const) {
    it(`does not expose the captured magic link in APP_MODE=${mode}`, async () => {
      const app = buildApp({
        mode,
        sessionMock: workingSessionMock(),
      });

      const response = await app.handle(
        new Request(`http://localhost${TEST_LAST_MAGIC_LINK_ROUTE_PATH}`),
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ code: 'NOT_FOUND', message: 'Not Found' });
    });
  }

  it('serves the captured magic link in APP_MODE=test', async () => {
    const app = buildApp({
      mode: APP_MODE.Test,
      sessionMock: workingSessionMock(),
    });

    const response = await app.handle(
      new Request(
        `http://localhost${TEST_LAST_MAGIC_LINK_ROUTE_PATH}?${MAGIC_LINK_EMAIL_QUERY_PARAMETER}=a@example.test`,
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: 'http://localhost:3000/api/auth/magic-link/verify?token=a-live',
    });
  });

  /**
   * THE PARALLELISM PROOF (2026-07-30). Both this route and its sibling used to read one global
   * "most recent mail" slot, and both callers are address-blind by construction. Playwright runs two
   * projects at once, so `magic-link.spec.ts` — which runs in both — had each browser reading a slot
   * the other could have just overwritten. Magic-link tokens are single use: one consumed it, the
   * other got a dead token and a guard redirect, which is the intermittent `items-filter` failure
   * this repo carried as "flaky" for a block.
   *
   * Asserted as a PAIR over the same mailbox, because either request alone passes against a broken
   * implementation that happens to favour the address being asked about.
   */
  it("gives each address its OWN latest link, never the mailbox's most recent", async () => {
    const app = buildApp({
      mode: APP_MODE.Test,
      sessionMock: workingSessionMock(),
    });

    const forA = await app.handle(
      new Request(
        `http://localhost${TEST_LAST_MAGIC_LINK_ROUTE_PATH}?${MAGIC_LINK_EMAIL_QUERY_PARAMETER}=a@example.test`,
      ),
    );
    const forB = await app.handle(
      new Request(
        `http://localhost${TEST_LAST_MAGIC_LINK_ROUTE_PATH}?${MAGIC_LINK_EMAIL_QUERY_PARAMETER}=b@example.test`,
      ),
    );

    // `b@` is the mailbox's last entry, so an unscoped implementation returns `b-live` for BOTH.
    expect(await forA.json()).toEqual({
      url: 'http://localhost:3000/api/auth/magic-link/verify?token=a-live',
    });
    expect(await forB.json()).toEqual({
      url: 'http://localhost:3000/api/auth/magic-link/verify?token=b-live',
    });
  });

  it("404s for an address that has no mail, rather than falling back to somebody else's", async () => {
    const app = buildApp({
      mode: APP_MODE.Test,
      sessionMock: workingSessionMock(),
    });

    const response = await app.handle(
      new Request(
        `http://localhost${TEST_LAST_MAGIC_LINK_ROUTE_PATH}?${MAGIC_LINK_EMAIL_QUERY_PARAMETER}=nobody@example.test`,
      ),
    );

    expect(response.status).toBe(404);
  });

  it('400s when the email parameter is missing — never silently reads the last mail', async () => {
    // A FALLBACK HERE WOULD RE-INTRODUCE THE RACE, and silently: a caller that forgot the parameter
    // would keep working, intermittently, exactly as before. So the absence is an error.
    const app = buildApp({
      mode: APP_MODE.Test,
      sessionMock: workingSessionMock(),
    });

    const response = await app.handle(
      new Request(`http://localhost${TEST_LAST_MAGIC_LINK_ROUTE_PATH}`),
    );

    expect(response.status).toBe(400);
  });

  it('refuses to mount at all in a fail-closed mode — the second lock', () => {
    const registered: string[] = [];
    const registrar = {
      all(path: string) {
        registered.push(path);
        return undefined;
      },
    };

    expect(() =>
      mountTestSessionRoute(registrar, APP_MODE.Production, workingSessionMock()),
    ).toThrow(/APP_MODE=test only/);
    expect(registered).toEqual([]);
  });

  /**
   * TASK-0008's own optional `catalogueManager` field — a small e2e-only capability grant riding
   * the same lock as everything else in this file (proven above; not re-proven here).
   *
   * Positive proof via CAPTURED SQL TEXT, the exact contract `fake-postgres.ts`'s own header
   * documents ("`respond` pattern-matches the compiled SQL text") — the fake has no real
   * `auth.app_user` row to check against, so the SQL statement actually issued is the only signal
   * available, the same way `catalogue-authoring-guards.test.ts`'s `sessionPoisonedBeyondLookup`
   * proves absence by what never got called.
   *
   * MUTATION PERFORMED AND RESTORED (ADR-0010): changed the guard in
   * `src/runtime/test-session-route.ts` from `if (body.catalogueManager === true)` to
   * `if (body.catalogueManager)` (a bare truthy check). The "omitted" and "explicit false" tests
   * below both stayed GREEN under that mutation only because neither ever sends a truthy
   * non-boolean value — so a THIRD case was added first (a stray truthy value, see below) which
   * goes red under the bare-truthy mutation and green under the strict `=== true` check; then all
   * three were re-run against the mutation to confirm two stayed red (omitted implicitly stays
   * `undefined`, which is falsy either way — so only the strict-equality check and the stray-value
   * case actually distinguish the two implementations) before the guard was reverted.
   */
  describe('catalogueManager (TASK-0008)', () => {
    function grantMatcher(text: string): boolean {
      return /update\s+auth\.app_user\s+set\s+catalogue_manager\s*=\s*true/i.test(text);
    }

    async function postSession(body: Record<string, unknown>) {
      const statements: { sql: string; parameters: readonly unknown[] }[] = [];
      const db = fakePostgresDb((sql, parameters) => {
        statements.push({ sql, parameters });
        return { rows: [] };
      });
      const app = buildApp({ mode: APP_MODE.Test, sessionMock: workingSessionMock({ db }) });
      const response = await app.handle(
        new Request(`http://localhost${TEST_SESSION_ROUTE_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      return { response, statements };
    }

    it('grants catalogue_manager when catalogueManager: true is posted', async () => {
      const { response, statements } = await postSession({
        email: SESSION_MOCK_EMAIL,
        catalogueManager: true,
      });

      expect(response.status).toBe(204);
      expect(statements.some((s) => grantMatcher(s.sql))).toBe(true);
      // Scoped to the address this request just authenticated, not a blanket UPDATE.
      const grant = statements.find((s) => grantMatcher(s.sql));
      expect(grant?.parameters).toContain(SESSION_MOCK_EMAIL);
    });

    it('leaves catalogue_manager untouched when the field is omitted', async () => {
      const { response, statements } = await postSession({ email: SESSION_MOCK_EMAIL });

      expect(response.status).toBe(204);
      expect(statements.some((s) => grantMatcher(s.sql))).toBe(false);
    });

    it('leaves catalogue_manager untouched when explicitly false', async () => {
      const { response, statements } = await postSession({
        email: SESSION_MOCK_EMAIL,
        catalogueManager: false,
      });

      expect(response.status).toBe(204);
      expect(statements.some((s) => grantMatcher(s.sql))).toBe(false);
    });

    // The case that actually distinguishes strict `=== true` from a bare truthy check (see the
    // mutation note above) — a stray non-boolean truthy value must NOT grant the capability.
    it('leaves catalogue_manager untouched for a non-boolean truthy value', async () => {
      const { response, statements } = await postSession({
        email: SESSION_MOCK_EMAIL,
        catalogueManager: 'true',
      });

      expect(response.status).toBe(204);
      expect(statements.some((s) => grantMatcher(s.sql))).toBe(false);
    });
  });

  /**
   * TASK-0009's own optional `moderator` field — the identical shape as `catalogueManager` above,
   * proven the same way and for the same reason: a fake with no real `auth.app_user` row, so the
   * captured SQL text is the only signal available.
   *
   * MUTATION PERFORMED AND RESTORED (ADR-0010), the exact same proof `catalogueManager`'s own note
   * documents: changed `if (body.moderator === true)` in `src/runtime/test-session-route.ts` to a
   * bare `if (body.moderator)`. "omitted" and "explicit false" both stayed GREEN under that
   * mutation (both send a falsy value either way), so the stray-truthy-value case below is what
   * actually distinguishes the two implementations — it goes red under the bare-truthy mutation and
   * green under the strict `=== true` check. All four were re-run against the mutation (two stayed
   * red, confirming they discriminate) before the guard was reverted to `=== true`.
   */
  describe('moderator (TASK-0009)', () => {
    function grantMatcher(text: string): boolean {
      return /update\s+auth\.app_user\s+set\s+moderator\s*=\s*true/i.test(text);
    }

    async function postSession(body: Record<string, unknown>) {
      const statements: { sql: string; parameters: readonly unknown[] }[] = [];
      const db = fakePostgresDb((sql, parameters) => {
        statements.push({ sql, parameters });
        return { rows: [] };
      });
      const app = buildApp({ mode: APP_MODE.Test, sessionMock: workingSessionMock({ db }) });
      const response = await app.handle(
        new Request(`http://localhost${TEST_SESSION_ROUTE_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      return { response, statements };
    }

    it('grants moderator when moderator: true is posted', async () => {
      const { response, statements } = await postSession({
        email: SESSION_MOCK_EMAIL,
        moderator: true,
      });

      expect(response.status).toBe(204);
      expect(statements.some((s) => grantMatcher(s.sql))).toBe(true);
      // Scoped to the address this request just authenticated, not a blanket UPDATE.
      const grant = statements.find((s) => grantMatcher(s.sql));
      expect(grant?.parameters).toContain(SESSION_MOCK_EMAIL);
    });

    it('leaves moderator untouched when the field is omitted', async () => {
      const { response, statements } = await postSession({ email: SESSION_MOCK_EMAIL });

      expect(response.status).toBe(204);
      expect(statements.some((s) => grantMatcher(s.sql))).toBe(false);
    });

    it('leaves moderator untouched when explicitly false', async () => {
      const { response, statements } = await postSession({
        email: SESSION_MOCK_EMAIL,
        moderator: false,
      });

      expect(response.status).toBe(204);
      expect(statements.some((s) => grantMatcher(s.sql))).toBe(false);
    });

    // The case that actually distinguishes strict `=== true` from a bare truthy check (see the
    // mutation note above) — a stray non-boolean truthy value must NOT grant the capability.
    it('leaves moderator untouched for a non-boolean truthy value', async () => {
      const { response, statements } = await postSession({
        email: SESSION_MOCK_EMAIL,
        moderator: 'true',
      });

      expect(response.status).toBe(204);
      expect(statements.some((s) => grantMatcher(s.sql))).toBe(false);
    });
  });

  /**
   * Both capability flags in ONE request body — TASK-0009's own dispatch note: "nothing prevents
   * that today, don't add an artificial exclusivity." Proven together so a future change that
   * makes one grant short-circuit the other (e.g. an `else if`) goes red here.
   */
  it('grants both catalogue_manager and moderator when both are posted true in one request', async () => {
    const statements: { sql: string; parameters: readonly unknown[] }[] = [];
    const db = fakePostgresDb((sql, parameters) => {
      statements.push({ sql, parameters });
      return { rows: [] };
    });
    const app = buildApp({ mode: APP_MODE.Test, sessionMock: workingSessionMock({ db }) });

    const response = await app.handle(
      new Request(`http://localhost${TEST_SESSION_ROUTE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: SESSION_MOCK_EMAIL,
          catalogueManager: true,
          moderator: true,
        }),
      }),
    );

    expect(response.status).toBe(204);
    expect(
      statements.some((s) =>
        /update\s+auth\.app_user\s+set\s+catalogue_manager\s*=\s*true/i.test(s.sql),
      ),
    ).toBe(true);
    expect(
      statements.some((s) => /update\s+auth\.app_user\s+set\s+moderator\s*=\s*true/i.test(s.sql)),
    ).toBe(true);
  });
});
