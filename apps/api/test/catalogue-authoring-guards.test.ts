/**
 * TASK-0008 Deliverable 4/5 — the `catalogue_manager` capability guard on `products.create`/
 * `products.update`, asserted at the HTTP layer exactly like TASK-0003's write-guard suite
 * (`write-guards-and-limits.test.ts`, read first for the exact style this file follows): "a guard
 * that is correct in isolation and unwired is the failure that test would miss." Every test drives
 * the real `buildApp(...)`-built app with `app.handle(request)` and the same
 * `test/harness/fake-postgres.ts`/`fake-session.ts` harness TASK-0003 established — see that
 * harness's own header for why this is a legitimate HTTP-layer proof rather than a shortcut around
 * one.
 *
 * MUTATION PERFORMED AND RESTORED (ADR-0010, this suite's own acceptance criterion — "removing the
 * capability check from the router turns a test red"): in `src/routes/products/products.router.ts`,
 * both the `create` and `update` handlers' `requireCatalogueManager(context);` line was temporarily
 * replaced with `requireSession(context);` (removing the capability half while leaving the session
 * half intact, so the mutation isolates exactly the property this suite exists to catch). With that
 * change in place, every "session without catalogue_manager" test below went from 403 to 500 —
 * `requireSession` let the session through, `updateProduct`/`createProduct` then issued a query the
 * fakes below deliberately poison beyond the session lookup, and the resulting unclassified error
 * mapped to `INTERNAL`/500 rather than the expected `FORBIDDEN`/403. The mutation was then reverted
 * (see the router's own `requireCatalogueManager` call) and this suite re-run green.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/runtime/build-app.js';
import { poisonedDb } from './harness/fake-postgres.js';
import { type FakeResolvedSessionOptions, fakeResolvedSession } from './harness/fake-session.js';

function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const VALID_CREATE_BODY = {
  name: 'Sony WH-1000XM5',
  description: 'Noise-cancelling over-ear headphones.',
  categoryName: 'audio',
  priceMinor: 34999,
  currencyCode: 'USD',
  sku: 'AUD-WH1000XM5',
};

/** A thrown, `Error`-shaped duck type matching what `@repo/reviews`'s
 * `translateUniqueViolation` narrows on (SQLSTATE `23505` plus the violated constraint name) —
 * mirrors a real `pg` driver error closely enough for that translator, without depending on `pg`
 * itself (this fake, like the module under test, has no such dependency). */
class FakeUniqueViolationError extends Error {
  readonly code = '23505';
  readonly constraint: string;
  constructor(constraint: string) {
    super(`fake unique violation on "${constraint}"`);
    this.constraint = constraint;
  }
}

/** A `fakeResolvedSession` that throws the instant any query beyond the session's own
 * `auth.app_user` lookup runs — the same "positive proof, not merely absence of evidence" shape
 * `poisonedDb()` gives the anonymous case, adapted to a RESOLVED session: the one query
 * `resolveRequestSession` itself needs is still answered (by `fakeResolvedSession` internally), so
 * a response that is cleanly 403 here is proof the capability guard stopped the pipeline before its
 * first query, not an artifact of a fake that always answers empty. */
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

describe('anonymous products.create/products.update -> 401 without the pipeline running', () => {
  it.each([
    ['POST', '/api/products', VALID_CREATE_BODY],
    ['PATCH', '/api/products/some-product', { name: 'A new name, long enough' }],
  ] as const)('%s %s -> 401, never touching the database', async (method, url, body) => {
    const app = buildApp({ db: poisonedDb() }); // no `session` dependency: `context.session` is
    // always undefined, so `requireSession` (inside `requireCatalogueManager`) is what must
    // answer — and `poisonedDb()` would turn any accidental pipeline call into a 500 instead of a
    // clean 401.
    const response = await app.handle(jsonRequest(url, method, body));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('a session lacking catalogue_manager -> 403 without the pipeline running', () => {
  it.each([
    ['POST', '/api/products', VALID_CREATE_BODY],
    ['PATCH', '/api/products/some-product', { name: 'A new name, long enough' }],
  ] as const)('%s %s -> 403, never touching the database beyond session resolution', async (method, url, body) => {
    const { session, db } = sessionPoisonedBeyondLookup({
      identityId: 'identity-non-manager',
      userId: 'user-non-manager',
      userToken: 'usr_NNNNNNNNNNNNNNNNNNNNN',
      catalogueManager: false,
    });
    const app = buildApp({ session, db });

    const response = await app.handle(jsonRequest(url, method, body));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  // The positive control the 403 tests above depend on: proves a session that DOES hold the
  // capability is actually let through to the pipeline (and therefore does hit the poisoned fake),
  // so a 403 above is the guard firing on the CAPABILITY, not an artifact of every request failing
  // regardless of who sends it.
  it('the same request with catalogue_manager: true reaches the pipeline (proved by the poison firing)', async () => {
    const { session, db } = sessionPoisonedBeyondLookup({
      identityId: 'identity-manager',
      userId: 'user-manager',
      userToken: 'usr_PPPPPPPPPPPPPPPPPPPPP',
      catalogueManager: true,
    });
    const app = buildApp({ session, db });

    const response = await app.handle(jsonRequest('/api/products', 'POST', VALID_CREATE_BODY));

    // Not 403, not 200 — the poisoned responder's Error is unclassified, so it maps to 500. The
    // POINT is that it is NOT 403: a manager session reaches the pipeline.
    expect(response.status).toBe(500);
  });
});

describe('products.create: server-side slug derivation over HTTP (TASK-0008, SPEC-0003)', () => {
  /** Answers the `INSERT INTO reviews.product` statement `createProduct` issues, echoing back
   * whatever was actually bound as parameters — so the response the client sees reflects EXACTLY
   * what the pipeline tried to write, including the slug value it decided on. */
  function respondToProductInsert(sqlText: string, parameters: readonly unknown[]) {
    if (!sqlText.toLowerCase().includes('insert into reviews.product')) {
      return { rows: [] };
    }
    const [slug, sku, name, description, categoryId, priceMinor, currencyCode] = parameters as [
      string,
      string,
      string,
      string,
      number,
      number,
      string,
    ];
    return {
      rows: [
        {
          slug,
          sku,
          name,
          description,
          product_category_id: categoryId,
          price_minor: priceMinor,
          currency_code: currencyCode,
          created_at: new Date('2024-01-01T00:00:00.000Z'),
          updated_at: new Date('2024-01-01T00:00:00.000Z'),
        },
      ],
    };
  }

  function managerApp() {
    const { session, db } = fakeResolvedSession({
      identityId: 'identity-manager',
      userId: 'user-manager',
      userToken: 'usr_QQQQQQQQQQQQQQQQQQQQQ',
      catalogueManager: true,
      respond: respondToProductInsert,
    });
    return buildApp({ session, db });
  }

  // Mutation: in `packages/reviews/src/products.ts`'s `createProduct`, change
  // `const slug = input.slug ?? deriveProductSlug(input.name);` to
  // `const slug = deriveProductSlug(input.name);` — this test still passes (no slug is supplied
  // here), but its sibling below goes red.
  it('derives the slug from name when omitted from the request', async () => {
    const app = managerApp();
    const response = await app.handle(
      jsonRequest('/api/products', 'POST', {
        ...VALID_CREATE_BODY,
        name: 'Sony  WH-1000XM5!!',
        // slug deliberately omitted
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { slug: string };
    expect(body.slug).toBe('sony-wh-1000xm5');
  });

  // Mutation: in `packages/reviews/src/products.ts`'s `createProduct`, change
  // `const slug = input.slug ?? deriveProductSlug(input.name);` to
  // `const slug = deriveProductSlug(input.name);` (dropping the `input.slug ??` half) — a supplied
  // slug is silently discarded and this test's assertion goes red, since `name` here derives to a
  // completely different slug than the one supplied.
  it('uses a supplied slug verbatim, never re-deriving it from name', async () => {
    const app = managerApp();
    const response = await app.handle(
      jsonRequest('/api/products', 'POST', {
        ...VALID_CREATE_BODY,
        name: 'A Totally Unrelated Name',
        slug: 'custom-slug-value',
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { slug: string };
    expect(body.slug).toBe('custom-slug-value');
  });
});

describe('products.create: duplicate slug/sku -> CONFLICT with details.field (SPEC-0003)', () => {
  it.each([
    ['uq_product__slug', 'slug'],
    ['uq_product__sku', 'sku'],
  ] as const)('a %s violation from the unique constraint answers CONFLICT with details.field: "%s"', async (constraint, field) => {
    const { session, db } = fakeResolvedSession({
      identityId: 'identity-manager',
      userId: 'user-manager',
      userToken: 'usr_RRRRRRRRRRRRRRRRRRRRR',
      catalogueManager: true,
      respond: (sqlText) => {
        if (sqlText.toLowerCase().includes('insert into reviews.product')) {
          throw new FakeUniqueViolationError(constraint);
        }
        return { rows: [] };
      },
    });
    const app = buildApp({ session, db });

    const response = await app.handle(jsonRequest('/api/products', 'POST', VALID_CREATE_BODY));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'CONFLICT', details: { field } });
  });
});

describe('products.update: slug/sku are rejected by the wire schema itself (TASK-0008, SPEC-0003)', () => {
  // Mutation: in `packages/contracts/src/contracts/products/products.ts`, remove `.strict()` from
  // `productsUpdateInputSchema` — Zod would then silently STRIP `slug`/`sku` instead of rejecting
  // the request, the handler would run with a plain `{ name }` patch, the poisoned responder below
  // would fire (since `updateProduct`/`getProductBySlug` would then run), and this test's `400`
  // assertion goes red (500, from the poison, instead of 400).
  it.each([
    ['slug', 'a-different-slug'],
    ['sku', 'NEW-SKU-VALUE'],
  ] as const)('a PATCH carrying "%s" -> 400 VALIDATION, never touching the database beyond session resolution', async (field, value) => {
    const { session, db } = sessionPoisonedBeyondLookup({
      identityId: 'identity-manager',
      userId: 'user-manager',
      userToken: 'usr_SSSSSSSSSSSSSSSSSSSSS',
      catalogueManager: true,
    });
    const app = buildApp({ session, db });

    const response = await app.handle(
      jsonRequest('/api/products/some-product', 'PATCH', {
        name: 'A new name, long enough',
        [field]: value,
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'VALIDATION' });
  });

  // The container-level proof that the stored row is byte-identical afterward (including
  // `updated_at`) lives in `packages/reviews/test-integration/product-write.test.ts`, following
  // TASK-0002's own mutation-comment convention there — this HTTP-layer test's job is only to
  // prove the WIRE schema itself is what rejects the request (never reaching a row to change), so
  // the two suites together cover the full claim without duplicating the same proof twice.
});
