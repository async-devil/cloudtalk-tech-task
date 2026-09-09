import { expect, test } from '../fixtures.js';

/**
 * The DoD smoke: "one trivial spec green". Needs only `vite preview` — no session, no api call, no
 * database — so it is the one spec in this suite that can prove the config is wired correctly even
 * when the api half of `webServer` cannot start (e.g. Postgres/Redis already bound to another
 * project's compose stack on the same host).
 */
test.describe('smoke: the built SPA serves the public sign-in screen', () => {
  test('loads /sign-in and renders the sign-in form', async ({ page }) => {
    await page.goto('/sign-in');

    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByLabel('Email address')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Email me a sign-in link' })).toBeVisible();
  });
});
