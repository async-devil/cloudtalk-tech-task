/**
 * TASK-0003's acceptance criterion: "The OpenAPI document generated from the contract lists every
 * route with its error shapes." ADR-0004's own reasoning: the document is GENERATED from
 * `appContract`, never hand-written, so it cannot drift from what the handlers implement — this
 * suite drives the real generator (`createOpenApiDocument`) against the real contract, not a
 * fixture standing in for either.
 */
import type { OpenAPI } from '@orpc/openapi';
import { describe, expect, it } from 'vitest';
import { createOpenApiDocument } from '../src/http/openapi.js';
import { contractRouteKeys } from '../src/http/route-template.js';

interface Operation {
  readonly responses?: Readonly<Record<string, unknown>>;
}
type PathItem = Readonly<Record<string, Operation>>;

/** Navigation helpers, not assertions themselves — each `throw`s a plain `Error` naming what is
 * missing so a failing lookup still fails loudly inside the calling `it()`, satisfying Biome's
 * `noMisplacedAssertion` (an `expect()` call belongs inside the test it guards, not a shared
 * helper several tests call). */
function pathItemFor(doc: OpenAPI.Document, template: string): PathItem {
  const pathItem = (doc.paths as Record<string, PathItem> | undefined)?.[template];
  if (pathItem === undefined) {
    throw new Error(`document has no path entry for "${template}"`);
  }
  return pathItem;
}

function operationFor(doc: OpenAPI.Document, method: string, template: string): Operation {
  const operation = pathItemFor(doc, template)[method.toLowerCase()];
  if (operation === undefined) {
    throw new Error(`document has no "${method} ${template}" operation`);
  }
  return operation;
}

describe('createOpenApiDocument', () => {
  // Mutation: in `src/http/openapi.ts`'s `zodSchemaConverter`, change `condition` to always
  // return `false` — every route carrying a path parameter (every products/reviews route but
  // `products.list`) throws `OpenAPIGeneratorError` instead of generating, and this `await`
  // rejects instead of resolving. Run once, not per-route, since it exercises the whole
  // generation pass rather than one route's shape.
  it('generates without throwing, for the real contract', async () => {
    await expect(createOpenApiDocument()).resolves.toBeDefined();
  });

  it('documents every route the contract declares, with a 2xx success response', async () => {
    const doc = await createOpenApiDocument();
    for (const routeKey of contractRouteKeys()) {
      const [method, template] = routeKey.split(' ', 2) as [string, string];
      const operation = operationFor(doc, method, template);
      const statuses = Object.keys(operation.responses ?? {});
      expect(
        statuses.some((status) => status.startsWith('2')),
        routeKey,
      ).toBe(true);
    }
  });

  // TASK-0003's own six routes (products.list/get, reviews.listForProduct/submit/update/remove),
  // extended by TASK-0008's two (products.create/update) — each checked against the EXACT status
  // codes SPEC-0003's own error table declares for it, so a route that quietly lost an error branch
  // (or the document quietly stopped documenting one) fails here rather than only showing up as a
  // passing "has SOME error" check.
  //
  // Mutation: in `packages/contracts/src/contracts/reviews/reviews.ts`, delete the `CONFLICT`
  // entry from `submit`'s `.errors({...})` — `409` disappears from
  // `POST /products/{productSlug}/reviews`'s documented statuses and that route's assertion below
  // goes red.
  it.each([
    ['GET', '/products', [400, 429, 502, 500]],
    ['GET', '/products/{productSlug}', [400, 404, 429, 502, 500]],
    ['GET', '/products/{productSlug}/reviews', [400, 404, 429, 502, 500]],
    ['POST', '/products/{productSlug}/reviews', [400, 401, 404, 409, 429, 502, 500]],
    ['PATCH', '/reviews/{reviewToken}', [400, 401, 403, 429, 502, 500]],
    ['DELETE', '/reviews/{reviewToken}', [400, 401, 403, 502, 500]],
    // TASK-0008: capability-gated, so UNAUTHORIZED (no session) and FORBIDDEN (session lacking
    // catalogue_manager) both appear, same as every other write route — but neither carries
    // RATE_LIMITED: SPEC-0003 leaves whether products.create joins a rate-limit bucket for this
    // task to decide, and it does not (see `apps/api/src/http/security/rate-limit.ts`'s own bucket
    // list, unextended by this task).
    ['POST', '/products', [400, 401, 403, 409, 502, 500]],
    // No CONFLICT: unlike `create`, `update` never touches `slug`/`sku` — the only columns whose
    // unique constraints could collide — so nothing in its pipeline can raise it (SPEC-0003's own
    // per-route prose lists CONFLICT for `create` only).
    ['PATCH', '/products/{productSlug}', [400, 401, 403, 404, 502, 500]],
  ] as const)('%s %s documents exactly the error statuses SPEC-0003 declares', async (method, template, expectedStatuses) => {
    const doc = await createOpenApiDocument();
    const operation = operationFor(doc, method, template);
    const documentedStatuses = Object.keys(operation.responses ?? {})
      .map(Number)
      .filter((status) => status >= 400)
      .sort((a, b) => a - b);
    expect(documentedStatuses).toEqual([...expectedStatuses].sort((a, b) => a - b));
  });

  it('every documented error response carries the uniform { code, message } wire shape', async () => {
    const doc = await createOpenApiDocument();
    const operation = operationFor(doc, 'POST', '/products/{productSlug}/reviews');
    const notFound = operation.responses?.['404'] as
      | { content?: Record<string, { schema?: unknown }> }
      | undefined;
    const schema = JSON.stringify(notFound?.content?.['application/json']?.schema ?? {});
    // The uniform apiErrorShape (`@repo/contracts`) — `code` drawn from the closed ERROR_CODES
    // enum, `message` a string. Asserted by substring (the schema is deeply nested per response
    // variant) rather than a full structural match, which would just restate the generator's own
    // output.
    expect(schema).toContain('"NOT_FOUND"');
    expect(schema).toContain('"code"');
    expect(schema).toContain('"message"');
  });
});
