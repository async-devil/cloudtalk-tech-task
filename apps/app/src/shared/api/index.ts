import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import { appContract } from '@repo/contracts';
import { z } from 'zod';

/**
 * `shared/api` — the ONE place this app talks to a server (ADR-0012).
 *
 * Nothing else may call `fetch`: the `no-fetch-outside-shared-api` gate
 * (`tools/arch-checks/src/no-fetch-outside-shared-api.ts`) fails the build on any other call site.
 * That is not tidiness — it is what makes credentials, base URL, error normalization and the 401
 * redirect properties of the APP rather than of whichever feature remembered them.
 */

/** The SPA's entire config surface. `import.meta.env` is the documented exception to "never read
 * env outside `@repo/config`" — Vite inlines `VITE_*` at build time, and everything else this
 * client needs arrives in the bootstrap payload instead. */
const DEFAULT_API_URL = 'http://localhost:3000';

/** Parsed, not trusted (ADR-0008): a mistyped `VITE_API_URL` is a build-time input, and failing
 * loudly at module load beats every request 404ing against a nonsense origin. */
const apiUrlSchema = z.url();

function readApiUrl(): string {
  const configured = import.meta.env.VITE_API_URL;
  if (configured === undefined || configured === '') {
    return DEFAULT_API_URL;
  }
  return apiUrlSchema.parse(configured);
}

/** The api's ORIGIN, with no path. Exported because better-auth's client (`shared/session`'s
 * `auth-client.ts`) appends its own `basePath` and must not be handed the `/api`-suffixed URL
 * below — see that file's header. */
export const API_ORIGIN = readApiUrl().replace(/\/$/, '');

/** The api mounts every contract route under `/api` (`apps/api`'s `Elysia#mount`), so the origin
 * from config and the mount prefix are joined here, once. */
export const API_BASE_URL = `${API_ORIGIN}/api`;

const link = new OpenAPILink(appContract, {
  url: API_BASE_URL,
  /**
   * `credentials: 'include'` is load-bearing. The session cookie is `HttpOnly`, so the client can
   * neither read nor attach it by hand — only this flag sends it, and the SPA is always
   * cross-origin from the api in development (`:5173` -> `:3000`). oRPC builds the `Request` itself
   * and exposes no credentials option, so it is re-created here with the flag set. Do NOT rely on
   * the runtime's default: a browser's is `same-origin` (every request would arrive anonymous and
   * 401), while Bun's is already `include` — which is exactly the kind of "works on my runtime" gap
   * that ships broken.
   *
   * The indirection through `globalThis` keeps the transport one stubbable seam, which is what lets
   * the guard suites drive the REAL client and the REAL error mapping against canned responses
   * rather than a hand-built fake client that could agree with the code by construction.
   */
  fetch: (request, init) =>
    globalThis.fetch(new Request(request, { credentials: 'include' }), init),
});

/**
 * The one oRPC client instance: typed end-to-end from `@repo/contracts`' `appContract` — the
 * contract IS the SDK (ADR-0004), so this app restates no route, no path and no payload shape.
 */
export const apiClient: ContractRouterClient<typeof appContract> = createORPCClient(link);

/**
 * The TanStack Query integration built from the same client: `apiQuery.<namespace>.<procedure>.
 * queryOptions()` / `.mutationOptions()` for feature slices.
 *
 * These utils generate their own query keys, shaped `[[...procedurePath], { type, input }]`.
 * `shared/query-keys` DERIVES from that same generator, so the two key spaces agree by
 * construction and a slice-prefix invalidation reaches an `apiQuery`-keyed query — asserted in
 * `test/query-keys.test.ts`, including the flat-array shape that does not. Feature authors: build
 * every key through `queryKeys`, never inline.
 */
export const apiQuery = createTanstackQueryUtils(apiClient);
