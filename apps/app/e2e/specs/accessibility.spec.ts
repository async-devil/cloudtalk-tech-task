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
