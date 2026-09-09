/**
 * `returnTo` is attacker-controlled input (it arrives in the query string) that the app later
 * navigates to. Validating it as an in-app PATH is what keeps the sign-in screen from being an
 * open redirect — and an open redirect that fires *after* the user authenticates is the expensive
 * kind.
 *
 * Driven through the route's real `validateSearch` schema, i.e. the same code the router runs.
 */
import { describe, expect, it } from 'vitest';
import { Route } from '../src/routes/sign-in.js';

function parseSearch(raw: Record<string, unknown>): { returnTo: string } {
  // Documented cast: `validateSearch` is typed by TanStack Router as a broad union of every
  // accepted validator form (a function, a standard-schema object, …). This route supplies a Zod
  // schema, and asserting the `.parse` half is what lets the suite drive the ROUTER'S OWN
  // validator rather than a re-declared copy of it — a copy would pass while the route shipped
  // something else entirely.
  const validate = Route.options.validateSearch as unknown as {
    parse: (input: unknown) => { returnTo: string };
  };
  return validate.parse(raw);
}

describe('/sign-in returnTo validation', () => {
  it('keeps an in-app path', () => {
    expect(parseSearch({ returnTo: '/orders?filter=open' }).returnTo).toBe('/orders?filter=open');
  });

  it('defaults to / when absent', () => {
    expect(parseSearch({}).returnTo).toBe('/');
  });

  it.each([
    'https://evil.example/steal',
    '//evil.example/steal',
    'http://evil.example',
    'javascript:alert(1)',
    'items',
  ])('refuses to carry %s off-site', (hostile) => {
    expect(parseSearch({ returnTo: hostile }).returnTo).toBe('/');
  });
});
