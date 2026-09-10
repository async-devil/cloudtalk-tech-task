import { expect, test } from '../fixtures.js';

/**
 * TASK-0004's own acceptance criterion: "A Playwright spec covers: browse, open a product, submit
 * a review, see it in the list." (SPEC-0001 J1 + J2 end to end.)
 *
 * ============================================================================================
 * BLOCKED ON: no product-seeding mechanism is reachable from this e2e suite yet.
 * ============================================================================================
 *
 * This spec needs at least one real `reviews.product` row to browse to and review. Investigated,
 * in the order TASK-0004's own dispatch names:
 *
 *   1. `apps/api`'s test-mode composition root (`apps/api/src/runtime/test-session-route.ts` and
 *      its siblings under `apps/api/src/runtime/`) — mints a session for ANY address (open signup,
 *      `AUTH_SIGNUP_POSTURE=open` in this stack), but has no analogous "seed a product" route and
 *      no hook for granting the `catalogue_manager` capability to a minted session. Without that
 *      capability, `products.create` answers `FORBIDDEN` regardless of session.
 *   2. `apps/app/e2e/harness/start-api-server.ts` — spawns the real composition root and runs
 *      `apps/api/src/db/migrate.ts` against the compose Postgres, but exposes no `Kysely` (or any
 *      other DB) handle back to the specs — it is a process-spawner, not a fixture provider.
 *   3. TASK-0006 ("seeded catalogue the screens assume", per SPEC-0001's own traceability table)
 *      has not landed yet — there is genuinely no seed data mechanism anywhere in this checkout.
 *
 * Per TASK-0004's own instruction, deliberately NOT worked around by: inventing a new backend
 * test-only product-creation route (out of scope for a frontend-focused change — that is
 * `apps/api` surface, and a route minted for exactly one e2e spec is the kind of change a review
 * should see argued on its own, not smuggled in here), or by asserting against a product slug that
 * does not exist and pretending that proves the review flow.
 *
 * WHAT THIS SPEC DOES INSTEAD, for now: proves the pieces that do not need seed data — an
 * authenticated visit to the public catalogue, and the empty state SPEC-0001 S2 specifies for a
 * genuinely empty catalogue (which, before TASK-0006 seeds anything, this checkout's compose
 * Postgres always is). The review-submission half is written out in full below and gated behind
 * `test.skip(true, …)`, so unblocking it later is "delete one line", not "write the spec from
 * scratch" — flip it once either TASK-0006's seed lands or `apps/api` grows a sanctioned
 * `catalogue_manager`-capable session mint for e2e.
 */
test.describe('catalogue and review submission (TASK-0004)', () => {
  test('an authenticated visitor can browse the public catalogue', async ({
    page,
    authenticate,
  }) => {
    await authenticate(`catalogue-${Date.now()}@example.test`);

    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Catalogue' })).toBeVisible();
    // Signed in — proven the same way `magic-link.spec.ts` proves a genuine session: a value only
    // a resolved session produces, not the mere absence of a redirect.
    await expect(page.getByTestId('session-user-token')).toBeVisible();
    // Before TASK-0006 seeds anything, this compose Postgres has no products — SPEC-0001 S2's own
    // "empty (no products)" state, not a broken page.
    await expect(page.getByText('No products in the catalogue yet.')).toBeVisible();
  });

  // `test.skip(title, fn)`, not a conditional `test.skip()` call inside the body: this spec is
  // unconditionally blocked on missing seed data (this file's header comment explains exactly
  // what is missing), so it is declared skipped from the outside — the same shape `test.only`
  // takes to declare a test, not the runtime early-exit form of `test.skip()`. Change back to
  // `test(...)` once a product is reachable in this suite.
  test.skip('browse, open a product, submit a review, and see it in the list', async ({
    page,
    authenticate,
  }) => {
    const email = `review-${Date.now()}@example.test`;
    await authenticate(email);

    // TODO(TASK-0006 or a sanctioned e2e product-seeding mechanism): replace with the real slug of
    // a seeded product once one exists.
    const productSlug = 'REPLACE-ME-WITH-A-SEEDED-PRODUCT-SLUG';

    await page.goto('/');
    await page.getByRole('link', { name: /./ }).first().click();
    await expect(page).toHaveURL(new RegExp(`/products/${productSlug}$`));

    await page.getByTestId('write-a-review').click();
    await page.getByRole('radio', { name: '5 stars' }).click();
    await page.getByLabel('Title').fill('Excellent purchase');
    await page
      .getByLabel('Review')
      .fill('This exceeded my expectations in every way, would recommend to anyone.');
    await page.getByTestId('review-submit').click();

    // The form closes and the new review appears in the own-review block above the list.
    await expect(page.getByTestId('write-a-review')).toHaveCount(0);
    await expect(page.getByLabel('Your review')).toContainText('Excellent purchase');
  });
});
