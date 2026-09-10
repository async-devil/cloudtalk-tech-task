import { test as base } from '@playwright/test';
import { API_BASE_URL } from './constants.js';
import { authenticateAs } from './harness/session-mock.js';

export interface AuthenticateOptions {
  /** TASK-0008: mints the session as a catalogue manager — see `harness/session-mock.ts`'s
   * `AuthenticateAsOptions.catalogueManager`. */
  readonly catalogueManager?: boolean;
  /** TASK-0009: mints the session as a moderator — see `harness/session-mock.ts`'s
   * `AuthenticateAsOptions.moderator`. Independent of `catalogueManager`, same as the field it
   * mirrors — a spec may request either, both, or neither. */
  readonly moderator?: boolean;
}

export interface E2eFixtures {
  /** The api's origin — every spec that talks to the api directly (session-mock, direct api
   * assertions) reads this instead of hardcoding `http://localhost:3000`. */
  readonly apiBaseURL: string;
  /**
   * One-call session-mock auth: `await authenticate('user@example.test')` mints a real session
   * and stores it in the CURRENT test's browser context — every `page` this test opens afterwards
   * is signed in as that address. `options.catalogueManager` (TASK-0008) additionally grants the
   * catalogue-authoring capability — a signature EXTENSION, not a second fixture, since
   * `authenticateAs` underneath is already a single options-object function and every existing
   * `authenticate(email)` call site stays source-compatible unchanged.
   */
  readonly authenticate: (email: string, options?: AuthenticateOptions) => Promise<void>;
}

/**
 * The one `test` every spec in this suite imports (instead of `@playwright/test`'s own), extended
 * with the two fixtures every non-trivial spec needs (session-mock support). Kept in one file so a
 * future fixture has one place to land rather than each spec inventing its own setup.
 */
export const test = base.extend<E2eFixtures>({
  // An OPTION fixture (`[value, { option: true }]`), not the usual `async ({}, use) => …` form.
  // Two constraints meet here and only this spelling satisfies both: Playwright PARSES the
  // fixture function's first parameter to work out what it depends on, and rejects anything but
  // an object destructuring pattern outright ("First argument must use the object destructuring
  // pattern") — while biome's `noEmptyPattern` rejects the empty `({}, use)` that Playwright's own
  // docs use. A plain option fixture takes no function at all, so neither rule has anything to
  // fire on, and it additionally gains what the callback form lacks: a spec or project can
  // override the api origin through `test.use({ apiBaseURL: … })`.
  apiBaseURL: [API_BASE_URL, { option: true }],
  authenticate: async ({ context, apiBaseURL }, use) => {
    await use((email: string, options?: AuthenticateOptions) =>
      authenticateAs(context, {
        apiBaseURL,
        email,
        // `exactOptionalPropertyTypes`: assign the property only when there is something to
        // assign, same idiom `shared/errors/api-error.ts`'s `ApiError` constructor uses.
        ...(options?.catalogueManager !== undefined
          ? { catalogueManager: options.catalogueManager }
          : {}),
        ...(options?.moderator !== undefined ? { moderator: options.moderator } : {}),
      }),
    );
  },
});

export { expect } from '@playwright/test';
