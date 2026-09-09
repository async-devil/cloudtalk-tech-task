import { expect, test } from '../fixtures.js';

/**
 * Proves the session-mock helper itself (`fixtures.ts`'s `authenticate`, `harness/session-mock.
 * ts`) against the REAL api + Postgres + Redis stack — the thing every other non-trivial spec in
 * this suite (magic-link excepted) builds on. Asserted against the api directly
 * (`/api/session/bootstrap`) rather than through the SPA's UI, so the proof stays narrow: one call
 * authenticates, and the api recognizes the result as a real, valid session.
 */
test.describe('smoke: the session-mock helper mints a real, api-recognized session', () => {
  test('authenticate() lets the context call a session-required route and get a real session back', async ({
    context,
    authenticate,
    apiBaseURL,
  }) => {
    // A fresh address per run, not a literal: two projects (or two re-runs against the same
    // long-lived compose database — this stack is deliberately left running between runs, see
    // `harness/start-api-server.ts`'s header) signing the SAME address up concurrently race
    // better-auth's identity insert and 500 on `auth.identity`'s unique email constraint.
    await authenticate(`e2e-session-mock-smoke-${crypto.randomUUID()}@example.test`);

    const response = await context.request.get(`${apiBaseURL}/api/session/bootstrap`);
    expect(response.status()).toBe(200);

    const body = (await response.json()) as { readonly userToken?: unknown };
    expect(body.userToken).toMatch(/^usr_[0-9A-Za-z]{21}$/);
  });
});
