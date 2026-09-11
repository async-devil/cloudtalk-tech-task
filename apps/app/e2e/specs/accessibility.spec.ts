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
 * seeded product — its controls are reachable regardless of catalogue contents — so it is covered
 * here now. S3/S4's star-rating keyboard test needs a real product page, which TASK-0006's seed
 * data (wired into `apps/app/e2e/harness/start-api-server.ts`) now provides — see below.
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

  test('S4: the star-rating control is operable by keyboard alone and announces its value', async ({
    page,
    authenticate,
  }) => {
    await authenticate(
      `a11y-star-rating-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`,
    );
    await page.goto('/');
    await page.getByLabel('Search').fill('Sony WH-1000XM5');
    await page.getByRole('link', { name: /Sony WH-1000XM5/ }).click();
    await page.getByTestId('write-a-review').click();

    // The announced-value live region SPEC-0001 S4 asks for
    // (`packages/styles/src/primitives/star-rating.tsx`'s `aria-live="polite"` span) — read once
    // before any interaction to confirm it starts in the "nothing chosen yet" state for this
    // brand-new session, not a stale value.
    const liveRegion = page.locator('[aria-live="polite"]');
    await expect(liveRegion).toHaveText('No rating selected');

    // `.focus()` establishes a known starting point on the control under test — this file's own
    // pattern for testing a specific control in isolation, distinct from the separate
    // "keyboard-only completion" test above, which specifically proves page-level Tab
    // reachability. From here on, ONLY keyboard interaction operates the control: no click()/tap()
    // on any radio.
    const oneStar = page.getByRole('radio', { name: '1 star' });
    await oneStar.focus();
    await expect(oneStar).toBeFocused();

    // Arrow keys move AND select in a native grouped radio — the "largely free" keyboard contract
    // star-rating.tsx's own header describes.
    await page.keyboard.press('ArrowRight');
    const twoStars = page.getByRole('radio', { name: '2 stars' });
    await expect(twoStars).toBeChecked();
    await expect(twoStars).toBeFocused();
    await expect(liveRegion).toHaveText('2 of 5 stars');

    // Home/End are the one part of the contract native grouped radios do NOT supply on their own —
    // star-rating.tsx's own keydown handler adds them.
    await page.keyboard.press('End');
    const fiveStars = page.getByRole('radio', { name: '5 stars' });
    await expect(fiveStars).toBeChecked();
    await expect(fiveStars).toBeFocused();
    await expect(liveRegion).toHaveText('5 of 5 stars');

    await page.keyboard.press('Home');
    await expect(oneStar).toBeChecked();
    await expect(oneStar).toBeFocused();
    await expect(liveRegion).toHaveText('1 of 5 stars');
  });
});
