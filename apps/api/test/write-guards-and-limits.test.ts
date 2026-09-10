/**
 * TASK-0003 Deliverable 4 — the assertions the task is explicit must live at the HTTP layer, not
 * as a unit test of the guard they exercise: "a guard that is correct in isolation and unwired is
 * the failure that test would miss." Every test here drives the real `buildApp(...)`-built app
 * with `app.handle(request)`, exactly like `test/build-app.test.ts`, and uses
 * `test/harness/fake-postgres.ts`/`fake-session.ts` to reach the real capability-module code
 * (`@repo/auth`'s `resolveRequestSession`, `@repo/reviews`'s `updateReview`/`removeReview`)
 * without a container — see that harness's own header for why that is a legitimate proof rather
 * than a shortcut around one.
 */
import { RateLimitedError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';
import type { RateLimiters } from '../src/http/security/rate-limit.js';
import { buildApp } from '../src/runtime/build-app.js';
import { poisonedDb } from './harness/fake-postgres.js';
import { fakeResolvedSession } from './harness/fake-session.js';

function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** A `RateLimiters` fake: every bucket allows by default, and a caller flips exactly the one
 * bucket the test cares about to always reject — so a test never has to implement all four. */
function fakeRateLimiters(rejecting: Partial<Record<keyof RateLimiters, true>>): RateLimiters {
  const rejected = () =>
    Promise.reject(
      new RateLimitedError('rate limit exceeded', { details: { retryAfterMs: 4_000 } }),
    );
  return {
    close: () => Promise.resolve(),
    checkAuth: rejecting.checkAuth ? rejected : () => Promise.resolve(),
    checkUnauthenticatedPost: rejecting.checkUnauthenticatedPost
      ? rejected
      : () => Promise.resolve(),
    checkAnonymousRead: rejecting.checkAnonymousRead ? rejected : () => Promise.resolve(),
    checkReviewSubmission: rejecting.checkReviewSubmission ? rejected : () => Promise.resolve(),
  };
}

describe('anonymous writes are 401 without the pipeline running', () => {
  // Mutation: in `src/routes/reviews/reviews.router.ts`'s `remove` handler, move the
  // `removeReview(...)` call to run BEFORE `requireSession(context)` — verified: moving only the
  // `requireDb(db)` call earlier does NOT turn this red (`requireDb` merely checks `db !==
  // undefined`, never touching a property, so `poisonedDb()` stays silent); the module call
  // itself has to run before the session check for the poison to fire. With that mutation,
  // `poisonedDb()` throws on the first property access, `classifyError` maps the unclassified
  // throw to `INTERNAL`/500, and this test's status assertion goes red (500, not 401).
  it.each([
    [
      'POST',
      '/api/products/some-product/reviews',
      {
        rating: 5,
        title: 'A title long enough',
        body: 'A body that is definitely long enough to pass.',
      },
    ],
    ['PATCH', '/api/reviews/rev_AAAAAAAAAAAAAAAAAAAAA', { title: 'A new title long enough' }],
    ['DELETE', '/api/reviews/rev_AAAAAAAAAAAAAAAAAAAAA', undefined],
  ] as const)('%s %s -> 401, never touching the database', async (method, url, body) => {
    const app = buildApp({ db: poisonedDb() }); // no `session` dependency at all: `context.session`
    // is always undefined, so `requireSession` must be what answers — and `poisonedDb()` would
    // turn any accidental module call into a 500 instead of a clean 401.
    const response = await app.handle(jsonRequest(url, method, body));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('editing or deleting a review is not an existence oracle (SPEC-0001 rule 5)', () => {
  const OWNER_USER_ID = 'author-owner-uuid';
  const OTHER_USER_ID = 'author-intruder-uuid';
  const REVIEW_TOKEN = 'rev_AAAAAAAAAAAAAAAAAAAAA';
  const MISSING_TOKEN = 'rev_ZZZZZZZZZZZZZZZZZZZZZ';

  /**
   * A fake db that plays the role of REAL Postgres for exactly the two statements
   * `updateReview`/`removeReview` issue: the pre-transaction owner lookup (by token only — it has
   * no `authorId` to filter on, since the module compares the row's own `author_id` in
   * application code) AND the atomic `UPDATE`/`DELETE ... WHERE token = $1 AND author_id = $2`
   * that is this pipeline's REAL enforcement point. The second statement is answered by checking
   * the ACTUAL bound `author_id` parameter against `ownerUserId` — mirroring what a real `WHERE`
   * clause does — so a caller whose session resolves to any id other than the true owner sees the
   * database (real or fake) answer zero rows, exactly as it would in production. `ownerUserId:
   * undefined` simulates a token that names no row at all.
   *
   * `callerUserId` is the id `fakeResolvedSession` hands back as `RequestSession.userId` — this
   * is what proves the ROUTER forwards that exact id as `updateReview`/`removeReview`'s
   * `authorId` rather than some other value (a wiring bug this suite's whole reason to exist,
   * TASK-0003's own words).
   */
  function appAsCaller(callerUserId: string, ownerUserId: string | undefined) {
    const { session, db } = fakeResolvedSession({
      identityId: `identity-${callerUserId}`,
      userId: callerUserId,
      userToken: 'usr_BBBBBBBBBBBBBBBBBBBBB',
      respond: (sql, params) => {
        const lower = sql.toLowerCase();
        if (lower.includes('select product_id, author_id from reviews.review')) {
          return {
            rows:
              ownerUserId !== undefined ? [{ product_id: 'prod-1', author_id: ownerUserId }] : [],
          };
        }
        if (lower.includes('pg_advisory_xact_lock')) {
          return { rows: [] };
        }
        // `authorLabelsForUserIds` (`@repo/auth`) — the router's post-write `authorLabel`
        // resolution. Any caller id answers with a fixed canned email; the label it derives to
        // is not what these tests are about.
        if (lower.includes('ai.email')) {
          return { rows: [{ app_user_id: callerUserId, email: 'owner@example.test' }] };
        }
        // The atomic statement's own ownership filter, honoured against the REAL bound
        // parameter — not merely against which branch of test setup was chosen.
        const boundAuthorId = params.at(-1);
        const rowMatches = ownerUserId !== undefined && boundAuthorId === ownerUserId;
        if (lower.includes('update reviews.review')) {
          return {
            rows: rowMatches
              ? [
                  {
                    token: REVIEW_TOKEN,
                    rating: 5,
                    title: 'An updated title, long enough',
                    body: 'An updated body, long enough to pass validation rules.',
                    created_at: new Date('2024-01-01T00:00:00.000Z'),
                    updated_at: new Date('2024-01-02T00:00:00.000Z'),
                  },
                ]
              : [],
          };
        }
        if (lower.includes('delete from reviews.review')) {
          return { rows: rowMatches ? [{ review_id: 'rid-1' }] : [] };
        }
        return { rows: [] };
      },
    });
    return buildApp({ session, db });
  }

  // The positive control every negative test below depends on: proves the fake actually grants
  // 200 when the caller genuinely owns the review, so a 403 elsewhere in this block is the guard
  // actually firing — not an artifact of the fake always answering empty. Also the wiring proof
  // itself: the router must forward `session.userId` (here `OWNER_USER_ID`) as `authorId`
  // verbatim for this to succeed.
  //
  // Mutation: in `src/routes/reviews/reviews.router.ts`'s `update` handler, change
  // `authorId: session.userId` to a hardcoded string — this test's owner would then never match
  // the fake's `boundAuthorId` check, and it goes red (403 instead of 200) alongside the SAME
  // mutation flipping the "another author" test's expectations the other way.
  it('PATCH by the true owner succeeds (200) — the control the 403 tests below depend on', async () => {
    const app = appAsCaller(OWNER_USER_ID, OWNER_USER_ID);
    const response = await app.handle(
      jsonRequest(`/api/reviews/${REVIEW_TOKEN}`, 'PATCH', {
        title: 'An updated title, long enough',
      }),
    );
    expect(response.status).toBe(200);
  });

  it('DELETE by the true owner succeeds (200) — the control the 403 tests below depend on', async () => {
    const app = appAsCaller(OWNER_USER_ID, OWNER_USER_ID);
    const response = await app.handle(jsonRequest(`/api/reviews/${REVIEW_TOKEN}`, 'DELETE'));
    expect(response.status).toBe(200);
  });

  // Mutation: in `packages/reviews/src/reviews.ts`'s `updateReview`, change the atomic
  // statement's `WHERE token = ${input.reviewToken} AND author_id = ${input.authorId}` to drop
  // the `author_id` clause — the fake's `rowMatches` check above would then need to change too to
  // stay meaningful, which is exactly the point: this suite is proving the ROUTER's wiring
  // (`authorId: session.userId`), while `packages/reviews/test-integration/
  // review-list-and-mutations.test.ts` is what proves the REAL SQL clause itself cannot be
  // dropped without a real Postgres row leaking through (a fake cannot observe a removed `WHERE`
  // clause it never executes). The mutation THIS test actually catches: in
  // `reviews.router.ts`'s `update` handler, swap `authorId: session.userId` for a hardcoded
  // OTHER_USER_ID-shaped literal instead of the intruder's own real session id — the "own review"
  // positive control above would then fail instead of this one, proving the two tests together
  // pin the correct value flows in both directions.
  it("PATCH on another author's review -> 403", async () => {
    const app = appAsCaller(OTHER_USER_ID, OWNER_USER_ID);
    const response = await app.handle(
      jsonRequest(`/api/reviews/${REVIEW_TOKEN}`, 'PATCH', {
        title: 'A hostile edit, long enough',
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it("PATCH on a review token that does not exist -> 403 (same shape as another author's)", async () => {
    const app = appAsCaller(OTHER_USER_ID, undefined);
    const response = await app.handle(
      jsonRequest(`/api/reviews/${MISSING_TOKEN}`, 'PATCH', { title: 'Editing nothing at all' }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it("DELETE on another author's review -> 403", async () => {
    const app = appAsCaller(OTHER_USER_ID, OWNER_USER_ID);
    const response = await app.handle(jsonRequest(`/api/reviews/${REVIEW_TOKEN}`, 'DELETE'));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it("DELETE on a review token that does not exist -> 403 (same shape as another author's)", async () => {
    const app = appAsCaller(OTHER_USER_ID, undefined);
    const response = await app.handle(jsonRequest(`/api/reviews/${MISSING_TOKEN}`, 'DELETE'));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  // THE existence-oracle proof: the two 403 bodies above are not merely "both 403" — they are
  // byte-identical, so nothing in the response lets a caller distinguish "wrong owner" from
  // "no such review" (SPEC-0001 rule 5, SPEC-0003).
  //
  // Mutation: in `packages/reviews/src/internal/resolve-review-owner.ts`'s `notOwnedError`, give
  // the "no row" call site a different message than the "wrong owner" call site (e.g. thread a
  // `reason` string through and vary the message by it) — both requests still answer 403, but the
  // bodies differ and this test goes red.
  it('another-author and non-existent-token bodies are byte-identical on both PATCH and DELETE', async () => {
    const otherAuthor = appAsCaller(OTHER_USER_ID, OWNER_USER_ID);
    const missing = appAsCaller(OTHER_USER_ID, undefined);

    const patchOther = await (
      await otherAuthor.handle(
        jsonRequest(`/api/reviews/${REVIEW_TOKEN}`, 'PATCH', { title: 'Edit attempt A' }),
      )
    ).json();
    const patchMissing = await (
      await missing.handle(
        jsonRequest(`/api/reviews/${MISSING_TOKEN}`, 'PATCH', { title: 'Edit attempt A' }),
      )
    ).json();
    expect(patchOther).toEqual(patchMissing);

    const deleteOther = await (
      await otherAuthor.handle(jsonRequest(`/api/reviews/${REVIEW_TOKEN}`, 'DELETE'))
    ).json();
    const deleteMissing = await (
      await missing.handle(jsonRequest(`/api/reviews/${MISSING_TOKEN}`, 'DELETE'))
    ).json();
    expect(deleteOther).toEqual(deleteMissing);
  });
});

describe('a limit above the ceiling is VALIDATION, never silently capped', () => {
  // Mutation: in `packages/contracts/src/contracts/products/products.ts`, change
  // `productsListInputSchema`'s `limit` from `z.coerce.number().int().min(1).max(50)` to drop
  // `.max(50)` — `?limit=500` would then validate and reach the handler (which would 500 on the
  // poisoned db instead of 400 on validation), and this test's status assertion goes red.
  it('GET /products?limit=500 -> 400 VALIDATION, without touching the database', async () => {
    const app = buildApp({ db: poisonedDb() });
    const response = await app.handle(
      new Request('http://localhost/api/products?limit=500', { method: 'GET' }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'VALIDATION' });
  });

  it('GET /products/{slug}/reviews?limit=500 -> 400 VALIDATION, without touching the database', async () => {
    const app = buildApp({ db: poisonedDb() });
    const response = await app.handle(
      new Request('http://localhost/api/products/some-product/reviews?limit=500', {
        method: 'GET',
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'VALIDATION' });
  });

  it('GET /products?limit=50 (the ceiling itself) is accepted as valid input, not rejected', async () => {
    // Proves the ceiling is inclusive: `db` still throws once reached (this is not asserting a
    // successful read, which is `packages/reviews/test-integration`'s job) but the FAILURE mode
    // must be the database poison (500/INTERNAL), never VALIDATION — otherwise the boundary is
    // off by one and 50 itself would be wrongly rejected.
    const app = buildApp({ db: poisonedDb() });
    const response = await app.handle(
      new Request('http://localhost/api/products?limit=50', { method: 'GET' }),
    );
    expect(response.status).not.toBe(400);
  });
});

describe('rate-limit rejections carry Retry-After (ADR-0019)', () => {
  // Mutation: in `src/http/index.ts`, delete the `withRetryAfterHeader(...)` wrapper around the
  // `anonymous-read` branch's `errorResponseFor(...)` call (return the bare error response
  // instead) — the header disappears and this test's header assertion goes red, even though the
  // status code alone would still read 429.
  it('anonymous-read: a GET with no session gets 429 with Retry-After', async () => {
    const app = buildApp({
      db: poisonedDb(),
      rateLimiters: fakeRateLimiters({ checkAnonymousRead: true }),
    });
    const response = await app.handle(
      new Request('http://localhost/api/products', { method: 'GET' }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('4');
    expect(await response.json()).toMatchObject({ code: 'RATE_LIMITED' });
  });

  // Mutation: in `src/http/security/rate-limit.ts`'s `isReviewSubmissionRoute`, change the
  // returned `Set` lookup to always return `false` — `checkReviewSubmission` is then never
  // called for this route, the fake limiter's rejection never fires, and this test's 429
  // assertion goes red (200, or whatever the unreached handler would have answered instead).
  it('review-submission: reviews.submit with a resolved session gets 429 with Retry-After', async () => {
    const { session, db } = fakeResolvedSession({
      identityId: 'identity-1',
      userId: 'author-1',
      userToken: 'usr_CCCCCCCCCCCCCCCCCCCCC',
    });
    const app = buildApp({
      session,
      db,
      rateLimiters: fakeRateLimiters({ checkReviewSubmission: true }),
    });
    const response = await app.handle(
      jsonRequest('/api/products/some-product/reviews', 'POST', {
        rating: 5,
        title: 'A perfectly fine title',
        body: 'A perfectly fine body that is long enough to pass validation.',
      }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('4');
    expect(await response.json()).toMatchObject({ code: 'RATE_LIMITED' });
  });

  // The negative half of the same proof: `reviews.remove` is deliberately NOT in the
  // `review-submission` bucket (ADR-0019) — a rejecting `checkReviewSubmission` must never fire
  // for it.
  it('review-submission does NOT cover reviews.remove: a DELETE succeeds past a rejecting limiter', async () => {
    const { session, db } = fakeResolvedSession({
      identityId: 'identity-1',
      userId: 'author-1',
      userToken: 'usr_DDDDDDDDDDDDDDDDDDDDD',
      respond: (sql) => {
        const lower = sql.toLowerCase();
        if (lower.includes('select product_id, author_id from reviews.review')) {
          return { rows: [{ product_id: 'prod-1', author_id: 'author-1' }] };
        }
        if (
          lower.startsWith('\n        delete from reviews.review') ||
          lower.includes('delete from reviews.review')
        ) {
          return { rows: [{ review_id: 'rid-1' }] };
        }
        return { rows: [] };
      },
    });
    const app = buildApp({
      session,
      db,
      rateLimiters: fakeRateLimiters({ checkReviewSubmission: true }),
    });
    const response = await app.handle(
      jsonRequest('/api/reviews/rev_AAAAAAAAAAAAAAAAAAAAA', 'DELETE'),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: 'rev_AAAAAAAAAAAAAAAAAAAAA' });
  });
});
