import { describe, expect, it } from 'vitest';
import {
  assertDeclaredRouteKeys,
  contractRouteKeys,
  contractRouteTemplates,
  routeKeyOf,
  routeTemplateOf,
} from '../src/http/route-template.js';

// The metric `route` attribute must stay a bounded enum (ADR-0009) and its templates must come
// from the oRPC contract rather than a hardcoded regex (ADR-0004). This suite pins that every
// declared path resolves to its own template and everything else collapses to `'other'`, so a
// cardinality explosion from per-request paths is structurally impossible.
describe('routeTemplateOf (contract-derived)', () => {
  it('maps a declared path to its own template', () => {
    expect(routeTemplateOf('/session/bootstrap')).toBe('/session/bootstrap');
  });

  it('maps every other path to "other" (no cardinality explosion)', () => {
    expect(routeTemplateOf('/nope')).toBe('other');
    expect(routeTemplateOf('/anything/at/all')).toBe('other');
    expect(routeTemplateOf('/')).toBe('other');
  });

  /**
   * The nesting regression guard. `appContract` groups procedures under namespace keys, so a
   * NON-recursive walk over it finds zero `~orpc.route.path` values and returns an EMPTY template
   * list — at which point every request reports `route: 'other'` (a silently useless RED metric)
   * and `assertDeclaredRouteKeys` rejects every legitimate bucket name at boot. Asserting the
   * exact set, rather than "length > 0", is what makes that failure visible here.
   */
  it('walks the nested contract: every namespace contributes its declared templates', () => {
    expect([...contractRouteTemplates()].sort()).toEqual([
      '/moderation/reviews',
      '/products',
      '/products/{productSlug}',
      '/products/{productSlug}/reviews',
      '/reviews/{reviewToken}',
      '/reviews/{reviewToken}/reject',
      '/reviews/{reviewToken}/restore',
      '/session/bootstrap',
    ]);
  });

  it('normalises method case when building a key', () => {
    expect(routeKeyOf('get', '/session/bootstrap')).toBe('GET /session/bootstrap');
  });
});

/**
 * Param routes work — `routeTemplateOf` turns `{param}` into a single non-slash segment, so a
 * concrete `/thing/123` collapses onto a declared `/thing/{id}`. The trap is SPELLING:
 * `/thing/:id` is Elysia and Express syntax that an oRPC contract never declares, so a rate-limit
 * bucket naming that string would match nothing and the route would silently go un-limited.
 * `assertDeclaredRouteKeys` converts that silent miss into a boot failure, and a guard against an
 * invisible failure needs its own proof.
 *
 * The `declared` list here is synthetic on purpose: the guard's logic is what is under test, and
 * pinning it to whatever routes this product happens to declare today would make the suite a
 * restatement of the contract rather than a test of the check.
 */
describe('assertDeclaredRouteKeys', () => {
  const declared = ['POST /items', 'GET /items', 'GET /items/{id}'];

  it('accepts route keys the contract declares, param routes included', () => {
    expect(() =>
      assertDeclaredRouteKeys(['POST /items', 'GET /items/{id}'], declared),
    ).not.toThrow();
  });

  it('rejects the Elysia/Express `:id` spelling, naming what the contract really declares', () => {
    expect(() => assertDeclaredRouteKeys(['GET /items/:id'], declared)).toThrow(/items\/\{id\}/);
  });

  it('rejects a concrete path mistaken for a template', () => {
    expect(() => assertDeclaredRouteKeys(['GET /items/123'], declared)).toThrow();
  });

  it('rejects a bare template with no method', () => {
    expect(() => assertDeclaredRouteKeys(['/items'], declared)).toThrow(/METHOD \/template/);
  });

  it('accepts a key the LIVE contract declares', () => {
    expect(() => assertDeclaredRouteKeys(['GET /session/bootstrap'])).not.toThrow();
  });

  it('rejects a route key no namespace of the live contract declares', () => {
    expect(() => assertDeclaredRouteKeys(['GET /session'])).toThrow(/session\/bootstrap/);
  });

  it('keys the live contract by method and template together', () => {
    expect(contractRouteKeys()).toContain('GET /session/bootstrap');
  });
});
