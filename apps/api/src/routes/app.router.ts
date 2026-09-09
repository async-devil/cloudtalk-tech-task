import { implement } from '@orpc/server';
import { appContract } from '@repo/contracts';
import type { HttpRequestContext } from '../http/error-mapper.js';
import { createSessionRouter } from './session/session.router.js';

/**
 * The one implementation of `appContract`, assembled from its per-namespace routers. Going
 * through `implement(appContract).router(...)` rather than handing `OpenAPIHandler` a hand-built
 * object is the completeness check: a namespace added to the contract and not implemented here is
 * a COMPILE error, not a 404 discovered in production.
 */
export function createAppRouter() {
  const impl = implement<typeof appContract, HttpRequestContext>(appContract);

  return impl.router({
    session: createSessionRouter(),
  });
}
