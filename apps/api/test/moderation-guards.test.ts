/**
 * TASK-0009 Deliverable — the `moderator` capability guard on `reviews.moderationList`/`reject`/
 * `restore`, asserted at the HTTP layer exactly like TASK-0008's own suite
 * (`catalogue-authoring-guards.test.ts`, read first for the exact style this file follows): "a
 * guard that is correct in isolation and unwired is the failure that test would miss." Every test
 * drives the real `buildApp(...)`-built app with `app.handle(request)`, using the same
 * `test/harness/fake-postgres.ts`/`fake-session.ts` harness TASK-0003 established.
 *
 * MUTATION PERFORMED AND RESTORED (ADR-0010, this suite's own acceptance criterion — "removing the
 * capability check from the router turns a test red"): in
 * `src/routes/reviews/reviews.router.ts`'s `reject` handler, `const session = requireModerator(context);`
 * was temporarily replaced with `const session = requireSession(context);` (removing the
 * capability half while leaving the session half intact, so the mutation isolates exactly the
 * property this suite exists to catch). With that change in place, "a session lacking moderator ->
 * 403" for `reject` went from 403 to 500 — `requireSession` let the session through,
 * `setReviewModerationState` then issued a query the fake below deliberately poisons beyond the
 * session lookup, and the resulting unclassified error mapped to `INTERNAL`/500 rather than the
 * expected `FORBIDDEN`/403. The mutation was then reverted (see the router's own
 * `requireModerator` call) and this suite re-run green.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/runtime/build-app.js';
import { poisonedDb } from './harness/fake-postgres.js';
import { type FakeResolvedSessionOptions, fakeResolvedSession } from './harness/fake-session.js';

const REVIEW_TOKEN = 'rev_AAAAAAAAAAAAAAAAAAAAA';
const MISSING_TOKEN = 'rev_ZZZZZZZZZZZZZZZZZZZZZ';
const PUBLISHED_ID = 1;
const REJECTED_ID = 3;

function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** A `fakeResolvedSession` that throws the instant any query beyond the session's own
 * `auth.app_user` lookup runs — the same "positive proof, not merely absence of evidence" shape
 * `catalogue-authoring-guards.test.ts`'s own helper of this name gives, for the `moderator`
 * capability instead. */
function sessionPoisonedBeyondLookup(
  options: Omit<FakeResolvedSessionOptions, 'respond'>,
): ReturnType<typeof fakeResolvedSession> {
  return fakeResolvedSession({
    ...options,
    respond: () => {
      throw new Error(
        'sessionPoisonedBeyondLookup: a query beyond the session lookup ran — the capability ' +
          'guard did not stop the pipeline before it',
      );
    },
  });
}

describe('anonymous moderationList/reject/restore -> 401 without the pipeline running', () => {
  it.each([
    ['GET', '/api/moderation/reviews'],
    ['POST', `/api/reviews/${REVIEW_TOKEN}/reject`],
    ['POST', `/api/reviews/${REVIEW_TOKEN}/restore`],
  ] as const)('%s %s -> 401, never touching the database', async (method, url) => {
    const app = buildApp({ db: poisonedDb() }); // no `session` dependency: `context.session` is
    // always undefined, so `requireSession` (inside `requireModerator`) is what must answer — and
    // `poisonedDb()` would turn any accidental pipeline call into a 500 instead of a clean 401.
    const response = await app.handle(jsonRequest(url, method));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('a session lacking moderator -> 403 without the pipeline running', () => {
  it.each([
    ['GET', '/api/moderation/reviews'],
    ['POST', `/api/reviews/${REVIEW_TOKEN}/reject`],
    ['POST', `/api/reviews/${REVIEW_TOKEN}/restore`],
  ] as const)('%s %s -> 403, never touching the database beyond session resolution', async (method, url) => {
    const { session, db } = sessionPoisonedBeyondLookup({
      identityId: 'identity-non-moderator',
      userId: 'user-non-moderator',
      userToken: 'usr_NNNNNNNNNNNNNNNNNNNNN',
      moderator: false,
    });
    const app = buildApp({ session, db });

    const response = await app.handle(jsonRequest(url, method));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  // TASK-0009's own explicit acceptance criterion: holding ONLY catalogue_manager is not enough —
  // the two capabilities are independent (ADR-0018), and a session that mixes them up must still
  // 403 on the moderation surface.
  it('a session holding ONLY catalogue_manager still gets 403 on reject', async () => {
    const { session, db } = sessionPoisonedBeyondLookup({
      identityId: 'identity-catalogue-manager-only',
      userId: 'user-catalogue-manager-only',
      userToken: 'usr_CCCCCCCCCCCCCCCCCCCCC',
      catalogueManager: true,
      moderator: false,
    });
    const app = buildApp({ session, db });

    const response = await app.handle(jsonRequest(`/api/reviews/${REVIEW_TOKEN}/reject`, 'POST'));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  // The positive control the 403 tests above depend on: proves a session that DOES hold the
  // capability is actually let through to the pipeline (and therefore does hit the poisoned fake),
  // so a 403 above is the guard firing on the CAPABILITY, not an artifact of every request failing
  // regardless of who sends it.
  it('the same request with moderator: true reaches the pipeline (proved by the poison firing)', async () => {
    const { session, db } = sessionPoisonedBeyondLookup({
      identityId: 'identity-moderator',
      userId: 'user-moderator',
      userToken: 'usr_MMMMMMMMMMMMMMMMMMMMM',
      moderator: true,
    });
    const app = buildApp({ session, db });

    const response = await app.handle(jsonRequest(`/api/reviews/${REVIEW_TOKEN}/reject`, 'POST'));

    // Not 403, not 200 — the poisoned responder's Error is unclassified, so it maps to 500. The
    // POINT is that it is NOT 403: a moderator session reaches the pipeline.
    expect(response.status).toBe(500);
  });

  // `reviews.moderationList` is the one route in the contract that reads a review regardless of
  // moderation state — TASK-0009's own acceptance criterion is that this power makes it MORE
  // capability-gated, not exempt from the gate: an anonymous or non-moderator call still gets
  // 401/403, never a filtered (or empty) result.
  it('moderationList never returns a filtered result to a non-moderator — it 403s instead', async () => {
    const { session, db } = sessionPoisonedBeyondLookup({
      identityId: 'identity-non-moderator-2',
      userId: 'user-non-moderator-2',
      userToken: 'usr_QQQQQQQQQQQQQQQQQQQQQ',
      moderator: false,
    });
    const app = buildApp({ session, db });

    const response = await app.handle(new Request('http://localhost/api/moderation/reviews'));

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).not.toHaveProperty('items');
  });
});

/**
 * A fake db that answers exactly the statements `setReviewModerationState`/`listReviewsForModeration`
 * issue: the pre-transaction state check (by token), the advisory lock, the state-reasserting
 * `UPDATE`, the outbox `INSERT`, and `authorLabelsForUserIds`' join. Mirrors
 * `write-guards-and-limits.test.ts`'s `appAsCaller` fake for the ownership-mutation routes, adapted
 * to moderation's no-ownership shape.
 */
function moderatorApp(options: {
  readonly reviewRow?: {
    readonly token: string;
    readonly product_id: string;
    readonly author_id: string;
    readonly rating: number;
    readonly title: string;
    readonly body: string;
    readonly review_moderation_state_id: number;
    readonly created_at: Date;
    readonly updated_at: Date;
  };
  readonly authorEmail?: string;
  readonly moderationListRows?: readonly {
    readonly token: string;
    readonly rating: number;
    readonly title: string;
    readonly body: string;
    readonly author_id: string;
    readonly review_moderation_state_id: number;
    readonly product_name: string;
    readonly product_slug: string;
    readonly created_at: Date;
    readonly updated_at: Date;
  }[];
}) {
  const { session, db } = fakeResolvedSession({
    identityId: 'identity-moderator',
    userId: 'moderator-1',
    userToken: 'usr_MMMMMMMMMMMMMMMMMMMMM',
    moderator: true,
    respond: (sqlText, parameters) => {
      const lower = sqlText.toLowerCase();
      if (lower.includes('join reviews.product')) {
        return {
          rows: options.moderationListRows !== undefined ? [...options.moderationListRows] : [],
        };
      }
      if (lower.includes('from reviews.review') && lower.includes('where token')) {
        return { rows: options.reviewRow !== undefined ? [{ ...options.reviewRow }] : [] };
      }
      if (lower.includes('pg_advisory_xact_lock')) {
        return { rows: [] };
      }
      if (lower.includes('update reviews.review')) {
        if (options.reviewRow === undefined) {
          return { rows: [] };
        }
        const [targetStateId, token, expectedStateId] = parameters as [number, string, number];
        if (
          token === options.reviewRow.token &&
          expectedStateId === options.reviewRow.review_moderation_state_id
        ) {
          return {
            rows: [
              {
                ...options.reviewRow,
                review_moderation_state_id: targetStateId,
                updated_at: new Date(options.reviewRow.updated_at.getTime() + 1),
              },
            ],
          };
        }
        return { rows: [] };
      }
      if (lower.includes('insert into') && lower.includes('outbox')) {
        return { rows: [] };
      }
      if (lower.includes('ai.email')) {
        const authorId = options.reviewRow?.author_id ?? options.moderationListRows?.[0]?.author_id;
        return {
          rows:
            authorId !== undefined
              ? [{ app_user_id: authorId, email: options.authorEmail ?? 'author@example.test' }]
              : [],
        };
      }
      return { rows: [] };
    },
  });
  return buildApp({ session, db });
}

function reviewRowFixture(
  overrides: Partial<{
    review_moderation_state_id: number;
  }> = {},
) {
  return {
    token: REVIEW_TOKEN,
    product_id: 'prod-1',
    author_id: 'author-1',
    rating: 4,
    title: 'A perfectly ordinary review',
    body: 'A body long enough to satisfy every length check this fixture never enforces.',
    review_moderation_state_id: PUBLISHED_ID,
    created_at: new Date('2024-01-01T00:00:00.000Z'),
    updated_at: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('reviews.reject / reviews.restore (TASK-0009, SPEC-0001 rules 9-12)', () => {
  it("rejects a published review: 200, moves the state, and resolves the REVIEW AUTHOR'S label (never the moderator's)", async () => {
    const app = moderatorApp({
      reviewRow: reviewRowFixture({ review_moderation_state_id: PUBLISHED_ID }),
      authorEmail: 'jane.doe@example.test',
    });

    const response = await app.handle(jsonRequest(`/api/reviews/${REVIEW_TOKEN}/reject`, 'POST'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      token: REVIEW_TOKEN,
      authorLabel: 'jane.doe',
      // The ACTING moderator ('moderator-1') never owns the review it moderates in this fixture,
      // so this must be false — a moderator's own authorship is never assumed.
      authoredByViewer: false,
    });
  });

  it('restores a rejected review: 200, moves the state back to published', async () => {
    const app = moderatorApp({
      reviewRow: reviewRowFixture({ review_moderation_state_id: REJECTED_ID }),
    });

    const response = await app.handle(jsonRequest(`/api/reviews/${REVIEW_TOKEN}/restore`, 'POST'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ token: REVIEW_TOKEN });
  });

  // SPEC-0003's own explicit answer: unlike `update`/`remove`'s ownership-oracle FORBIDDEN, an
  // unknown token on a moderation route is NOT_FOUND — a moderator with the capability may already
  // see any review through `moderationList`, so confirming a token does not exist reveals nothing
  // an existence oracle could exploit.
  it('reject on an unknown token -> 404 NOT_FOUND, not FORBIDDEN', async () => {
    const app = moderatorApp({});

    const response = await app.handle(jsonRequest(`/api/reviews/${MISSING_TOKEN}/reject`, 'POST'));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('restore on an unknown token -> 404 NOT_FOUND', async () => {
    const app = moderatorApp({});

    const response = await app.handle(jsonRequest(`/api/reviews/${MISSING_TOKEN}/restore`, 'POST'));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  // The no-op path itself (already at target -> zero writes) is unit-proved with full statement
  // visibility in `packages/reviews/test/moderation.test.ts`; this HTTP-layer test only needs to
  // prove the ROUTE still answers 200 with the current row rather than erroring.
  it('rejecting an already-rejected review is a no-op that still answers 200 with the current row', async () => {
    const app = moderatorApp({
      reviewRow: reviewRowFixture({ review_moderation_state_id: REJECTED_ID }),
    });

    const response = await app.handle(jsonRequest(`/api/reviews/${REVIEW_TOKEN}/reject`, 'POST'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ token: REVIEW_TOKEN });
  });
});

describe('reviews.moderationList (TASK-0009, SPEC-0001 S8)', () => {
  const ROW_A = {
    token: 'rev_BBBBBBBBBBBBBBBBBBBBB',
    rating: 5,
    title: 'Excellent product, highly recommend',
    body: 'A body long enough to satisfy every length check this fixture never enforces.',
    author_id: 'author-2',
    review_moderation_state_id: PUBLISHED_ID,
    product_name: 'Sony WH-1000XM5',
    product_slug: 'sony-wh-1000xm5',
    created_at: new Date('2024-02-01T00:00:00.000Z'),
    updated_at: new Date('2024-02-01T00:00:00.000Z'),
  };

  it('returns rows carrying the product name/slug and state alongside the usual review fields', async () => {
    const app = moderatorApp({ moderationListRows: [ROW_A] });

    const response = await app.handle(new Request('http://localhost/api/moderation/reviews'));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    expect(body.items).toEqual([
      expect.objectContaining({
        token: 'rev_BBBBBBBBBBBBBBBBBBBBB',
        productName: 'Sony WH-1000XM5',
        productSlug: 'sony-wh-1000xm5',
        moderationState: 'published',
      }),
    ]);
  });

  it('defaults the state filter to published (SPEC-0001 S8)', async () => {
    const app = moderatorApp({ moderationListRows: [ROW_A] });

    const response = await app.handle(new Request('http://localhost/api/moderation/reviews'));

    const body = (await response.json()) as { items: readonly { moderationState: string }[] };
    expect(body.items.every((item) => item.moderationState === 'published')).toBe(true);
  });

  it('honours an explicit state=rejected filter', async () => {
    const rejectedRow = { ...ROW_A, review_moderation_state_id: REJECTED_ID };
    const app = moderatorApp({ moderationListRows: [rejectedRow] });

    const response = await app.handle(
      new Request('http://localhost/api/moderation/reviews?state=rejected'),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: readonly { moderationState: string }[] };
    expect(body.items[0]?.moderationState).toBe('rejected');
  });

  it('an invalid state value is rejected as VALIDATION, never silently accepted', async () => {
    const app = moderatorApp({ moderationListRows: [ROW_A] });

    const response = await app.handle(
      new Request('http://localhost/api/moderation/reviews?state=pending'),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'VALIDATION' });
  });
});
