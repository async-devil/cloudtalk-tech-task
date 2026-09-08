import { oc } from '@orpc/contract';

/**
 * An intentionally empty oRPC router (zero procedures), for a composition root that currently
 * has no route to mount. oRPC-contract construction stays isolated inside this package even for
 * a contract with nothing in it — an app never calls `oc.router(...)` itself, so a young,
 * fast-moving dependency's surface is confined to one place that can absorb a breaking change.
 */
export const emptyContract = oc.router({});
