import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/runtime/build-app.js';

/**
 * `buildApp` is exported precisely so it can be driven without a socket. This suite exercises only
 * wiring that never touches Postgres or Redis, so it constructs the app with no dependencies at
 * all — every one of them is optional by design, and absence is the fail-closed default rather
 * than a convenience for tests.
 */
describe('buildApp', () => {
  it('returns 404 for a route the contract does not declare', async () => {
    const app = buildApp({});
    const response = await app.handle(new Request('http://localhost/nope'));
    expect(response.status).toBe(404);
  });

  it('mounts the contract under /api: an undeclared /api path reaches the oRPC adapter and comes back as the uniform unmatched-route 404', async () => {
    const app = buildApp({});
    const response = await app.handle(
      new Request('http://localhost/api/anything', { method: 'GET' }),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: 'NOT_FOUND', message: 'Not Found' });
  });

  /**
   * Contract routes are session-required. With no `session` dependency wired at all,
   * `requireSession` always 401s — that is the fail-closed default, and this suite supplies no
   * auth wiring precisely to assert it.
   *
   * The bootstrap route matters most here: the SPA's very first call is session-required too, and
   * the 401 it gets is what the router-level handler redirects to `/sign-in` on. A route that
   * answered 200 to an anonymous caller would break that contract silently.
   */
  it('returns 401 for an anonymous GET /session/bootstrap when no session dependency is wired', async () => {
    const app = buildApp({});
    const response = await app.handle(
      new Request('http://localhost/api/session/bootstrap', { method: 'GET' }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('answers the uniform wire error shape, not a framework default, on every error path', async () => {
    const app = buildApp({});
    const body = (await (
      await app.handle(new Request('http://localhost/api/session/bootstrap'))
    ).json()) as Record<string, unknown>;
    // `code` and `message` are the contract's error shape; a framework default would carry
    // neither, and a leaked internal would carry more.
    expect(Object.keys(body).sort()).toEqual(['code', 'message']);
  });
});
