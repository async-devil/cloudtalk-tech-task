/**
 * The SPA bootstrap route, driven directly through oRPC's `call` — no HTTP, no database, no
 * better-auth. The handler's whole job is to orchestrate, so its contract with the rest of the
 * system is exactly a `RequestSession` in and a `SessionBootstrap` out.
 *
 * What this suite really guards is ADR-0011's rule that only PUBLIC tokens cross the wire. The
 * fake session below carries a distinctive internal uuid as `userId`, and the payload is asserted
 * not to contain it — a handler that returned `session.userId` instead of `session.userToken`,
 * which is the exact mistake this route exists to avoid, fails here.
 */
import { call, ORPCError } from '@orpc/server';
import type { RequestSession } from '@repo/auth';
import { ERROR_CODE } from '@repo/kernel';
import { describe, expect, it } from 'vitest';
import type { HttpRequestContext } from '../src/http/error-mapper.js';
import { createSessionRouter } from '../src/routes/session/session.router.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

function session(): RequestSession {
  return { userId: USER_ID, userToken: 'usr_AAAAAAAAAAAAAAAAAAAAA' };
}

function contextWithSession(): HttpRequestContext {
  return { routeTemplate: '/session/bootstrap', method: 'GET', session: session() };
}

describe('session.bootstrap', () => {
  it('returns the public token and the onboarding flag', async () => {
    const payload = await call(createSessionRouter().bootstrap, undefined, {
      context: contextWithSession(),
    });

    expect(payload).toEqual({
      userToken: 'usr_AAAAAAAAAAAAAAAAAAAAA',
      onboardingComplete: true,
    });
  });

  it('never lets an internal uuid cross the wire (ADR-0011)', async () => {
    const payload = await call(createSessionRouter().bootstrap, undefined, {
      context: contextWithSession(),
    });

    // Serialized rather than field-by-field on purpose: a future field that accidentally carried
    // the internal id would pass a per-field assertion and fail this one.
    expect(JSON.stringify(payload)).not.toContain(USER_ID);
  });

  it('throws UnauthorizedError when no session was resolved', async () => {
    await expect(
      call(createSessionRouter().bootstrap, undefined, {
        context: { routeTemplate: '/session/bootstrap', method: 'GET' },
      }),
      // `toOrpcError` maps the kernel `UnauthorizedError` onto the uniform wire shape at this
      // boundary — mapped once, by type, never by message matching (ADR-0008). That 401 is what
      // the SPA's router-level handler redirects on.
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ORPCError);
      const orpcError = error as ORPCError<string, unknown>;
      expect(orpcError.code).toBe(ERROR_CODE.Unauthorized);
      expect(orpcError.status).toBe(401);
      return true;
    });
  });
});
