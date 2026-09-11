import { expect, test } from '../fixtures.js';

/**
 * TASK-0004's own acceptance criterion: "A Playwright spec covers: browse, open a product, submit
 * a review, see it in the list." (SPEC-0001 J1 + J2 end to end.)
 *
 * Unblocked by TASK-0006: `apps/app/e2e/harness/start-api-server.ts` now seeds a real catalogue
 * (`apps/api/src/db/seed.ts`) into the shared compose Postgres before spawning the api, so this
 * spec targets the seeded `sony-wh-1000xm5` product by name — the same search-then-click-by-name
 * pattern `catalogue-authoring.spec.ts` already uses to find one product regardless of how many
 * others exist, rather than a fragile "click the first link" (whose target depends on the
 * catalogue's default `rating` sort and every seeded product's current aggregate).
 *
 * The review-author email carries a random suffix, not just `Date.now()`: unlike every other spec
 * in this suite, this test submits a review against a SHARED, pre-existing product rather than one
 * it creates itself, and both Chromium projects (`desktop-chromium`/`mobile-chromium`) run
 * concurrently against the same compose Postgres — a same-millisecond `Date.now()` collision would
 * otherwise risk two authors racing the `(product_id, author_id)` natural key.
 */
const SEEDED_PRODUCT_NAME = 'Sony WH-1000XM5';
const SEEDED_PRODUCT_SLUG = 'sony-wh-1000xm5';

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
}

test.describe('catalogue and review submission (TASK-0004)', () => {
  test('an authenticated visitor can browse the public catalogue', async ({
    page,
    authenticate,
  }) => {
    await authenticate(uniqueEmail('catalogue'));

    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Catalogue' })).toBeVisible();
    // Signed in — proven the same way `magic-link.spec.ts` proves a genuine session: a value only
    // a resolved session produces, not the mere absence of a redirect.
    await expect(page.getByTestId('session-user-token')).toBeVisible();
    // The seeded catalogue is browsable — searching for a known seeded product finds it.
    await page.getByLabel('Search').fill(SEEDED_PRODUCT_NAME);
    await expect(page.getByRole('link', { name: new RegExp(SEEDED_PRODUCT_NAME) })).toBeVisible();
  });

  test('browse, open a product, submit a review, and see it in the list', async ({
    page,
    authenticate,
  }) => {
    await authenticate(uniqueEmail('review'));

    await page.goto('/');
    await page.getByLabel('Search').fill(SEEDED_PRODUCT_NAME);
    await page.getByRole('link', { name: new RegExp(SEEDED_PRODUCT_NAME) }).click();
    await expect(page).toHaveURL(new RegExp(`/products/${SEEDED_PRODUCT_SLUG}$`));

    await page.getByTestId('write-a-review').click();
    // `force: true`: the radio is visually `sr-only` and its own star glyph paints exactly on top
    // of it (verified: the glyph's rendered box contains the input's computed click point), which
    // Playwright's actionability check correctly flags — but a real click there still selects the
    // star, because the click lands inside the `<label>` wrapping both, and the browser's native
    // label-forwarding activates the associated input regardless of what painted on top of it.
    await page.getByRole('radio', { name: '5 stars' }).click({ force: true });
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
