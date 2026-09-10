import { implement } from '@orpc/server';
import { appContract } from '@repo/contracts';
import type { Kysely } from 'kysely';
import type { HttpRequestContext } from '../http/error-mapper.js';
import { createProductsRouter } from './products/products.router.js';
import { createReviewsRouter } from './reviews/reviews.router.js';
import { createSessionRouter } from './session/session.router.js';

/**
 * The one implementation of `appContract`, assembled from its per-namespace routers. Going
 * through `implement(appContract).router(...)` rather than handing `OpenAPIHandler` a hand-built
 * object is the completeness check: a namespace added to the contract and not implemented here is
 * a COMPILE error, not a 404 discovered in production.
 *
 * `db` is optional — the same precedent `HttpHandlerDeps.session`/`.rateLimiters` already set
 * (`http/index.ts`) — so a suite with no interest in the products/reviews surface keeps
 * constructing the router unchanged; absence fails closed inside each handler
 * (`routes/require-db.ts`), never by crashing on an undefined `Kysely` handle.
 */
export function createAppRouter(deps: { readonly db?: Kysely<unknown> } = {}) {
  const impl = implement<typeof appContract, HttpRequestContext>(appContract);

  return impl.router({
    session: createSessionRouter(),
    products: createProductsRouter(deps.db),
    reviews: createReviewsRouter(deps.db),
  });
}
