import { expect, test } from '../fixtures.js';

/**
 * TASK-0008's own acceptance criterion: "A Playwright spec covers: sign in as the seeded manager,
 * create a product, see it in the catalogue, edit its name, and confirm the address did not
 * change."
 *
 * NOT blocked on TASK-0006 seed data the way `catalogue-and-review.spec.ts` is (see that file's
 * own header) — `authenticate(email, { catalogueManager: true })` (the e2e capability-grant
 * mechanism this dispatch adds to `test-session-route.ts`) is exactly what unblocks it, so this is
 * a real, running test rather than another `test.skip`.
 */
test.describe('catalogue authoring (TASK-0008)', () => {
  test('a manager creates a product, sees it in the catalogue, edits its name, and the address does not change', async ({
    page,
    authenticate,
  }) => {
    const unique = Date.now();
    const email = `catalogue-authoring-${unique}@example.test`;
    await authenticate(email, { catalogueManager: true });

    const productName = `E2E Test Product ${unique}`;

    await page.goto('/products/new');
    await page.getByLabel('Name').fill(productName);
    await page
      .getByLabel('Description')
      .fill('A product created end-to-end by the catalogue-authoring spec.');
    await page.getByLabel('Category').fill('Audio');
    await page.getByLabel('Price').fill('99.99');
    await page.getByLabel('Currency').fill('USD');
    await page.getByLabel('SKU').fill(`E2E-${unique}`);

    await page.getByTestId('product-form-submit').click();

    // Lands on the new product's detail page (SPEC-0001 S7's "on success, navigate to the new
    // product's detail page") and its heading is what a screen reader would land on.
    await expect(page.getByRole('heading', { name: productName })).toBeVisible();
    const productUrl = page.url();

    // Appears in the catalogue.
    await page.goto('/');
    await page.getByLabel('Search').fill(productName);
    await expect(page.getByRole('link', { name: new RegExp(productName) })).toBeVisible();

    // Edit its name; the address (the slug in the URL) must not change.
    await page.goto(productUrl);
    await page.getByTestId('edit-product-link').click();

    const editedName = `${productName} (edited)`;
    await page.getByLabel('Name').fill(editedName);
    await page.getByTestId('product-form-submit').click();

    await expect(page).toHaveURL(productUrl);
    await expect(page.getByRole('heading', { name: editedName })).toBeVisible();
  });
});
