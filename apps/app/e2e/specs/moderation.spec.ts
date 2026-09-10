import { expect, test } from '../fixtures.js';

/**
 * TASK-0009's own acceptance criterion: "A Playwright spec covers: sign in as the seeded
 * moderator, reject a review, confirm it is gone from the product's public review list, restore
 * it, confirm it is back."
 *
 * ============================================================================================
 * CHOREOGRAPHY (stated explicitly, `catalogue-authoring.spec.ts`'s own documentation style):
 * ============================================================================================
 * ONE authenticated identity for the whole spec, granted BOTH `catalogueManager` AND `moderator`
 * — not two separate sessions for "the author" and "the moderator". Reasoning:
 *
 *   - This suite has no TASK-0006 seed data to depend on (the same gap
 *     `catalogue-and-review.spec.ts`'s header documents at length), so a product and a review on
 *     it both have to be created BY this spec, through the UI, before there is anything to
 *     moderate at all.
 *   - SPEC-0001 rule 9's spirit is that a moderator is USUALLY not the same person as a review's
 *     author, but nothing in the data model forbids a moderator rejecting their own review
 *     (SPEC-0001's own actor table: "holding one capability implies nothing about the other").
 *     Modelling "usually" with a second `authenticate()` call and a second `BrowserContext` buys
 *     this spec nothing it needs to prove the acceptance criterion, and Playwright's own
 *     multi-actor choreography (two contexts, two cookie jars, coordinating which one is on which
 *     page when) is exactly the fragility TASK-0009's own dispatch warns against over-engineering
 *     into a test.
 *   - A useful side effect: because this session is both the review's author AND the moderator
 *     acting on it, `reviews.listForProduct`'s OWN-REVIEW lookup (SPEC-0001 rule 11: a rejected
 *     review is excluded from "the product's review list, the author's own-review lookup... and
 *     the rating aggregate") becomes a strong, unambiguous signal for "gone from the product's
 *     public review list" — once rejected, the own-review block disappears from product detail
 *     and "Write a review" reappears in its place, and the review's own title stops appearing
 *     anywhere on the page at all. That is read from the SAME `reviews.listForProduct` procedure a
 *     signed-out visitor would read, not a moderation-only view of it.
 *
 * Flow: sign in once (catalogue manager + moderator) -> create a product -> submit a review on it
 * -> moderation screen, reject it -> back on the product, confirm the review is gone -> moderation
 * screen, switch to the Rejected filter, restore it -> back on the product, confirm it is back.
 */
test.describe('review moderation (TASK-0009)', () => {
  test('a moderator rejects a review, it disappears from the product, then restoring brings it back', async ({
    page,
    authenticate,
  }) => {
    const unique = Date.now();
    const email = `moderation-${unique}@example.test`;
    await authenticate(email, { catalogueManager: true, moderator: true });

    const productName = `Moderation Test Product ${unique}`;
    const reviewTitle = `A review worth moderating ${unique}`;

    // --- Seed a product (identical shape to catalogue-authoring.spec.ts) ---
    await page.goto('/products/new');
    await page.getByLabel('Name').fill(productName);
    await page.getByLabel('Description').fill('A product seeded by the moderation spec.');
    await page.getByLabel('Category').fill('Audio');
    await page.getByLabel('Price').fill('49.99');
    await page.getByLabel('Currency').fill('USD');
    await page.getByLabel('SKU').fill(`MOD-${unique}`);
    await page.getByTestId('product-form-submit').click();

    await expect(page.getByRole('heading', { name: productName })).toBeVisible();
    const productUrl = page.url();

    // --- Submit a review on it (the real UI flow `catalogue-and-review.spec.ts` leaves skipped) ---
    await page.getByTestId('write-a-review').click();
    await page.getByRole('radio', { name: '5 stars' }).click();
    await page.getByLabel('Title').fill(reviewTitle);
    await page
      .getByLabel('Review')
      .fill('Written by the moderation spec so there is something to reject and restore.');
    await page.getByTestId('review-submit').click();

    // The form closes and the new review appears in the own-review block above the list.
    await expect(page.getByTestId('write-a-review')).toHaveCount(0);
    await expect(page.getByLabel('Your review')).toContainText(reviewTitle);

    // --- Moderate: reject it ---
    await page.goto('/moderation');
    await expect(page.getByRole('heading', { name: 'Moderation' })).toBeVisible();
    // Defaults to the `published` filter (SPEC-0001 S8) — no need to touch the state control here.
    const rejectButton = page.getByRole('button', {
      name: new RegExp(`^Reject review by .+ on ${productName}$`),
    });
    await expect(rejectButton).toBeVisible();
    await rejectButton.click();

    // No confirmation dialog anywhere in this flow (SPEC-0001 S8: reversible, so it does not need
    // one) — the click above is the entire interaction. The row drops out of the `published`
    // filter once the reject succeeds and the list re-fetches.
    await expect(
      page.getByRole('button', { name: new RegExp(`^Reject review by .+ on ${productName}$`) }),
    ).toHaveCount(0);

    // --- Confirm it is gone from the product's public review list ---
    await page.goto(productUrl);
    await expect(page.getByTestId('write-a-review')).toBeVisible();
    await expect(page.getByLabel('Your review')).toHaveCount(0);
    await expect(page.getByText(reviewTitle)).toHaveCount(0);

    // --- Moderate: restore it ---
    await page.goto('/moderation');
    await page.getByLabel('State').selectOption({ label: 'Rejected' });
    const restoreButton = page.getByRole('button', {
      name: new RegExp(`^Restore review by .+ on ${productName}$`),
    });
    await expect(restoreButton).toBeVisible();
    await restoreButton.click();

    // Reversed the same way: the row drops out of the `rejected` filter once restored.
    await expect(
      page.getByRole('button', { name: new RegExp(`^Restore review by .+ on ${productName}$`) }),
    ).toHaveCount(0);

    // --- Confirm it is back ---
    await page.goto(productUrl);
    await expect(page.getByLabel('Your review')).toContainText(reviewTitle);
  });
});
