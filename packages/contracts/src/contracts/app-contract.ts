import { oc } from '@orpc/contract';
import { sessionContract } from './session/session.js';

/**
 * **The** composed contract router this product serves and its SPA consumes. One name for one
 * thing: `apps/api` mounts this, `apps/app`'s oRPC client is typed from this, and neither
 * restates the other's routes — the wire contract IS the boundary between them (ADR-0004).
 *
 * NESTED, not flattened: the namespaces here are the ones the client calls through (e.g.
 * `apiQuery.session.bootstrap`) and the ones a query-key factory would mirror. Nesting does NOT
 * touch the wire: oRPC's OpenAPI handler routes on each procedure's own declared `route.path`, so
 * a route's path stays fixed however deeply the procedure sits in this object.
 *
 * A composition root that adds a route adds it to the contract *first* (contract-first,
 * ADR-0004) — never as an unnamed handler on the HTTP side.
 */
export const appContract = oc.router({
  session: sessionContract,
});
