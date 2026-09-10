import { expect, test } from '../fixtures.js';

/**
 * A11y assertions over the sign-in flow — the one interactive form left reachable in this app
 * without a session, and so the natural home for the design system's floor: an unlabelled field, a
 * div where a button belongs, or a control the keyboard cannot reach shows up here before it
 * reaches any authenticated screen.
 */

/** Spelled as a literal, independently of the token, so lowering the token goes red rather than
 * quietly agreeing with itself. */
const MINIMUM_TOUCH_TARGET_PX = 44;

test.describe('a11y: the sign-in flow', () => {
  test('every interactive element on /sign-in shows a visible focus-visible ring on keyboard focus', async ({
    page,
  }) => {
    await page.goto('/sign-in');
    await expect(page.getByLabel('Email address')).toBeVisible();

    const controls = page.locator('main button:visible, main input:visible');
    const count = await controls.count();
    // Guard against the vacuous pass: too few controls means the loop below runs too few times to
    // mean anything.
    expect(
      count,
      'too few interactive controls on /sign-in — the assertion would be vacuous',
    ).toBeGreaterThanOrEqual(2);

    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index);
      const description = await control.evaluate(
        (element) =>
          `${element.tagName.toLowerCase()}[name=${(element as HTMLInputElement).name || '?'}]`,
      );

      // KEYBOARD focus specifically. `focus()` triggers `:focus-visible` for these elements;
      // a mouse click must not, which is the property that stops authors deleting focus rings.
      await control.focus();
      const outline = await control.evaluate((element) => {
        const style = getComputedStyle(element);
        return { width: Number.parseFloat(style.outlineWidth), style: style.outlineStyle };
      });
      expect(outline.width, `${description} paints no focus outline`).toBeGreaterThan(0);
      expect(outline.style, `${description} paints outline-style: none`).not.toBe('none');
    }
  });

  test('every touch target on /sign-in has a bounding box of at least 44x44 on the mobile project', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'mobile-chromium',
      'the computed touch-target floor is a mobile-project assertion',
    );

    await page.goto('/sign-in');
    await expect(page.getByLabel('Email address')).toBeVisible();

    const controls = page.locator('main button:visible, main input:visible');
    const count = await controls.count();
    expect(
      count,
      'too few interactive controls on /sign-in — the assertion would be vacuous',
    ).toBeGreaterThanOrEqual(2);

    for (let index = 0; index < count; index += 1) {
      const box = await controls.nth(index).boundingBox();
      expect(box).not.toBeNull();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(MINIMUM_TOUCH_TARGET_PX);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(MINIMUM_TOUCH_TARGET_PX);
    }
  });

  /**
   * Keyboard-only completion. NO `click()` or `tap()` anywhere in this test, by design — the point
   * is that the flow is reachable and submittable without a pointer at all, which is how a
   * screen-reader or switch-access user drives it.
   */
  test('the sign-in form is completable using only the keyboard', async ({ page }) => {
    const email = `a11y-keyboard-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

    await page.goto('/sign-in');

    // Tab from the document into the first control, then type. `focus()` would bypass the very
    // thing under test — whether tab order actually reaches the field.
    const emailField = page.getByLabel('Email address');
    await expect(emailField).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(emailField).toBeFocused();

    await page.keyboard.type(email);
    // Enter inside a text input submits its form — the standard behaviour a custom handler most
    // often breaks.
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('magic-link-sent')).toBeVisible();
  });

  /**
   * The label/control pairing, asserted through the ACCESSIBLE NAME rather than by looking for a
   * `<label>` element: `getByLabel` resolves the same way assistive technology does, so a visually
   * adjacent label with a broken `htmlFor` fails here exactly as it would fail a real user.
   */
  test('the email field is reachable by its accessible name', async ({ page }) => {
    await page.goto('/sign-in');

    await expect(page.getByLabel('Email address')).toBeVisible();
  });
});

/**
 * TASK-0004's own acceptance criterion ("the rating control is operable by keyboard alone and
 * announces its value; asserted in the accessibility e2e pass") and SPEC-0001's non-functional
 * floor ("the e2e accessibility pass covers S2, S3, S4 and S8"). S2 (the catalogue) needs no
 * seeded product — its controls are reachable on a genuinely empty catalogue, which is this
 * checkout's actual state before TASK-0006 lands — so it is covered here now. S3/S4's star-rating
 * keyboard test is a real product page away, and hits the identical blocker
 * `catalogue-and-review.spec.ts`'s header documents in full: no product-seeding mechanism is
 * reachable from this e2e suite yet. Declared skipped from the outside for the same reason that
 * spec's second test is, rather than left unmentioned.
 */
test.describe('a11y: the catalogue (S2)', () => {
  test('every interactive control on / shows a visible focus-visible ring on keyboard focus', async ({
    page,
    authenticate,
  }) => {
    await authenticate(`a11y-catalogue-${Date.now()}@example.test`);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Catalogue' })).toBeVisible();

    const controls = page.locator('main input:visible, main select:visible, main button:visible');
    const count = await controls.count();
    expect(
      count,
      'too few interactive controls on / — the assertion would be vacuous',
    ).toBeGreaterThanOrEqual(2);

    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index);
      const description = await control.evaluate(
        (element) =>
          `${element.tagName.toLowerCase()}[name=${(element as HTMLInputElement).name || '?'}]`,
      );
      await control.focus();
      const outline = await control.evaluate((element) => {
        const style = getComputedStyle(element);
        return { width: Number.parseFloat(style.outlineWidth), style: style.outlineStyle };
      });
      expect(outline.width, `${description} paints no focus outline`).toBeGreaterThan(0);
      expect(outline.style, `${description} paints outline-style: none`).not.toBe('none');
    }
  });

  test('the search, category and sort controls are reachable by their accessible names', async ({
    page,
    authenticate,
  }) => {
    await authenticate(`a11y-catalogue-labels-${Date.now()}@example.test`);
    await page.goto('/');

    await expect(page.getByLabel('Search')).toBeVisible();
    await expect(page.getByLabel('Category')).toBeVisible();
    await expect(page.getByLabel('Sort')).toBeVisible();
  });

  test.skip('S4: the star-rating control is operable by keyboard alone and announces its value', async () => {
    // Blocked on the same missing product-seeding mechanism `catalogue-and-review.spec.ts`
    // documents in full — reaching S4 requires a real product page to open a review form on.
    // Flip this back to `test(...)` alongside that file's skipped review-submission test, once
    // either TASK-0006's seed lands or a sanctioned e2e product-seeding mechanism exists.
  });
});
