import { appContract } from '@repo/contracts';

/**
 * Route-template resolution for the RED metric's `route` attribute (ADR-0009): the template comes
 * from the routing layer — specifically the oRPC contract's own route definitions, the single
 * source of path templates — NOT a regex hardcoded in the metrics wrapper. A concrete request
 * path collapses to its template; anything the contract does not declare -> `'other'`, so a 404
 * path can never mint its own unbounded series.
 *
 * The contract is `@repo/contracts`'s `appContract` — the ONE composed router this app serves and
 * a typed client would consume; there is deliberately no second name for it here. oRPC-contract
 * construction stays isolated inside `@repo/contracts`, so this app never calls `oc.router(...)`
 * itself.
 *
 * oRPC (pinned `@orpc/contract`/`@orpc/server`) stores each contract procedure's declared route
 * under the `~orpc` meta key; we read `route.path` there rather than restating the paths. If a
 * future oRPC major moves that meta, the matcher list is simply empty and every path reports
 * `'other'` — a metric-cardinality degradation, never a request failure.
 */
const ORPC_META_KEY = '~orpc';

interface ContractProcedureMeta {
  readonly [ORPC_META_KEY]?: {
    readonly route?: { readonly path?: string; readonly method?: string };
  };
}

/**
 * The identity of a route for selection purposes: `"GET /session/bootstrap"`. A bare template
 * stops identifying a route the moment two procedures share one path with different methods (and
 * therefore wildly different cost) — naming both the method and the template keeps any future
 * selection unambiguous, even though today's contract has no such collision.
 */
export function routeKeyOf(method: string, template: string): string {
  return `${method.toUpperCase()} ${template}`;
}

/** `{param}` path segments become a single non-slash segment; every other character is literal. */
function templateToRegExp(template: string): RegExp {
  const pattern = template
    .split(/\{[^}]+\}/)
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+');
  return new RegExp(`^${pattern}$`);
}

/**
 * Walks a contract router — which is a plain, arbitrarily NESTED object of procedures
 * (`appContract` groups them by namespace, e.g. `session`) — collecting every declared
 * `route.path`. Recursion is not decoration: a flat `Object.values` walk over a nested router
 * sees only sub-routers, finds no `~orpc.route.path` on any of them, and produces an EMPTY
 * matcher list — every request would then report `route: 'other'` and `assertDeclaredRouteKeys`
 * would reject every legitimate name. Nesting does not touch the wire (oRPC's OpenAPI handler
 * routes on each procedure's own path), so this walk is the only thing that has to know the
 * shape.
 */
function collectRoutes(
  node: unknown,
  into: Array<{ readonly method: string; readonly path: string }>,
): void {
  if (node === null || typeof node !== 'object') {
    return;
  }
  const route = (node as ContractProcedureMeta)[ORPC_META_KEY]?.route;
  if (route !== undefined && typeof route.path === 'string') {
    // oRPC's own default when a contract omits `method` is POST; mirroring it here keeps this
    // walk's answer identical to what the handler actually routes on.
    into.push({ method: (route.method ?? 'POST').toUpperCase(), path: route.path });
    return;
  }
  for (const child of Object.values(node)) {
    collectRoutes(child, into);
  }
}

const DECLARED_ROUTES: ReadonlyArray<{ readonly method: string; readonly path: string }> = (() => {
  const routes: Array<{ method: string; path: string }> = [];
  collectRoutes(appContract, routes);
  return routes;
})();

/** Deduped by path: the RED metric's `route` attribute is a TEMPLATE, and two methods sharing one
 * path are one bucket there by design (ADR-0009 — no ids, bounded cardinality). */
const ROUTE_MATCHERS: ReadonlyArray<{ readonly template: string; readonly matcher: RegExp }> = [
  ...new Set(DECLARED_ROUTES.map(({ path }) => path)),
].map((template) => ({ template, matcher: templateToRegExp(template) }));

/**
 * Every route template `appContract` actually declares, in oRPC's own `{param}` brace form.
 *
 * Exported so a composition root naming a SUBSET of routes for its own purposes can be validated
 * against reality at boot instead of trusting a hand-typed string. A name that matches nothing is
 * the dangerous case: the route silently misses whatever the subset was for, and nothing fails.
 */
export function contractRouteTemplates(): readonly string[] {
  return ROUTE_MATCHERS.map(({ template }) => template);
}

/**
 * Every route `appContract` declares, as `"METHOD /template"` keys — the form a composition root
 * would name a subset in.
 */
export function contractRouteKeys(): readonly string[] {
  return DECLARED_ROUTES.map(({ method, path }) => routeKeyOf(method, path));
}

/**
 * Throws unless every name in `routeKeys` is a `"METHOD /template"` pair `appContract` declares.
 * Callers that select a SUBSET of routes by name use this so a typo, or the wrong param syntax,
 * fails loudly at boot instead of silently selecting nothing.
 *
 * Pure and exported for its own test: the failure it guards against — a route quietly missing a
 * selection meant to include it — is invisible by construction, so the guard itself has to be
 * proven.
 *
 * @throws Error naming the unknown entries and what the contract actually declares.
 */
export function assertDeclaredRouteKeys(
  routeKeys: Iterable<string>,
  declaredRouteKeys: readonly string[] = contractRouteKeys(),
): void {
  const declared = new Set(declaredRouteKeys);
  const unknown = [...routeKeys].filter((routeKey) => !declared.has(routeKey));
  if (unknown.length > 0) {
    throw new Error(
      `route key(s) ${JSON.stringify(unknown)} are not declared by appContract (it declares ` +
        `${JSON.stringify([...declared])}). Write them as 'METHOD /template' using oRPC's brace ` +
        "form — 'GET /session/{id}', not 'GET /session/:id' and not a bare '/session' — or the " +
        'selection silently matches nothing.',
    );
  }
}

/** Collapses a concrete request path to its `appContract` route template, or `'other'`. The
 * handler runs behind Elysia's `mount('/api', ...)`, which strips the prefix, so the path seen
 * here is already stripped of the `/api` prefix. */
export function routeTemplateOf(pathname: string): string {
  for (const { template, matcher } of ROUTE_MATCHERS) {
    if (matcher.test(pathname)) {
      return template;
    }
  }
  return 'other';
}
