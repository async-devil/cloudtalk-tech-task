import { API_BASE_URL } from '../constants.js';
import { expect, test } from '../fixtures.js';
import { lastMagicLinkUrl } from '../harness/session-mock.js';

/**
 * "One test DOES drive the real [magic-link] flow end to end" — the proof that the session-mock
 * shortcut (`fixtures.ts`'s `authenticate`) stands in for something real, rather than the whole
 * suite trusting an assumption nothing checks.
 *
 * This is the ONLY test in the suite that touches `/sign-in`'s real submit path, `packages/auth`'s
 * cross-origin posture (better-auth trusts only origins named in `HTTP_CORS_ALLOWED_ORIGINS`), and
 * the browser's own cookie handling of the verify redirect. Everything else takes the shortcut,
 * which is exactly why this one must not: the sent mail exists only in the api process's
 * in-memory mail-sender capture, with no other HTTP-reachable reader, so this spec follows the
 * link through `TEST_LAST_MAGIC_LINK_ROUTE_PATH` — the same `APP_MODE=test`-only reader the
 * session mock uses.
 */
test.describe('auth: the real magic-link flow (proves what the session-mock shortcut stands in for)', () => {
  test('requesting a magic link from /sign-in and following it lands on an authenticated screen', async ({
    page,
    context,
  }) => {
    const email = `magic-link-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

    // A deep link, so the final assertion is about `returnTo` surviving the whole round trip —
    // request, mail, verify redirect — and not merely about landing somewhere signed in.
    await page.goto('/sign-in?returnTo=%2F%3Fwelcome%3D1');

    await page.getByLabel('Email address').fill(email);
    await page.getByTestId('sign-in-submit').click();

    // The confirmation is the proof the REQUEST succeeded cross-origin. Without the trusted-origin
    // configuration this step gets a 403 that the screen would render as an error, so asserting
    // the happy copy here is asserting that configuration.
    await expect(page.getByTestId('magic-link-sent')).toBeVisible();
    await expect(page.getByTestId('sign-in-error')).toHaveCount(0);

    // Read the link the api actually sent, then follow it AS THE BROWSER — `page.goto`, not an api
    // request, because the session cookie is `HttpOnly` and it is the browser's handling of the
    // verify redirect that has to work.
    // SCOPED TO THIS TEST'S OWN ADDRESS, and that is what makes the spec parallel-safe rather than
    // intermittently red: this spec runs in BOTH Playwright projects at once; the api's mailbox is
    // process-wide, so an unscoped "last mail" read would hand whichever browser read second the
    // OTHER one's URL. Magic-link tokens are single use, so one consumed it and the other got a
    // dead token, no session, and a guard redirect.
    const captured = await context.request.get(lastMagicLinkUrl(API_BASE_URL, email));
    expect(captured.status(), 'the api captured no magic-link mail').toBe(200);
    const { url } = (await captured.json()) as { readonly url: string };
    expect(url).toContain('/api/auth/magic-link/verify');

    await page.goto(url);

    // `returnTo` carried all the way through: the callback lands on `/?welcome=1`, not on `/`.
    await expect(page).toHaveURL(/\/\?welcome=1/);
    // And it is a genuine session — `/` is behind the session guard, so rendering it at all means
    // the guard let the request through rather than bouncing back to `/sign-in`.
    await expect(page.getByTestId('session-user-token')).toBeVisible();
  });
});
