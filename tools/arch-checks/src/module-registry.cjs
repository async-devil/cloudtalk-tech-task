/**
 * The registry of workspace module names, keyed by tier, plus the third-party provider-SDK
 * ownership list. This is the single source both consumers build from:
 *   - `.dependency-cruiser.cjs` (repo root) `require()`s this to construct the `tier-direction`,
 *     `no-tier2-unsanctioned` and `adapters-and-sdk-only-in-runtime` rules.
 *   - `depcruise-completeness.ts` imports it to check that every real workspace package has a name
 *     registered here — ADR-0001's closed name list.
 *
 * Adding a module means adding it here, deliberately: a new capability is an architectural change
 * (ADR-0003), and this file is where a reviewer sees it.
 *
 * CommonJS, not this workspace's default ESM (ADR-0002): `.dependency-cruiser.cjs` is a documented
 * ESM-only exception — tooling config, not shipped code — and must `require()` this synchronously
 * at config-load time.
 */
'use strict';

// Tier tags per ADR-0001: kernel -> facade -> capability -> app, with tooling off to the side.
const TIER_KERNEL = ['kernel'];
const TIER_FACADE = ['contracts', 'entities', 'observability', 'config', 'messaging'];
const TIER_CAPABILITY = ['persistence', 'jobs', 'auth', 'styles', 'reviews'];
const TIER_APP = ['api', 'app'];
const TIER_TOOLING = ['extract-module', 'arch-checks'];

// Which top-level workspace folder each registered module lives under.
const MODULE_FOLDER = new Map([
  ...TIER_KERNEL.map((name) => [name, 'packages']),
  ...TIER_FACADE.map((name) => [name, 'packages']),
  ...TIER_CAPABILITY.map((name) => [name, 'packages']),
  ...TIER_APP.map((name) => [name, 'apps']),
  ...TIER_TOOLING.map((name) => [name, 'tools']),
]);

/**
 * Sanctioned capability-to-capability edges (ADR-0001 point 2). Everything not listed here is
 * forbidden. The list starts nearly empty on purpose — each entry is an admission that two
 * bounded contexts are coupled, and it should be uncomfortable enough to argue for.
 */
const SANCTIONED_TIER2_EDGES = [
  // The job spine is itself a raw-SQL boundary: every row it reads comes back through
  // `rowAs`/`rowsAs` rather than a cast (ADR-0004, ADR-0006).
  { from: 'jobs', to: 'persistence' },
  // Same reason, for auth's own hand-written SQL — the user upsert and the session middleware's
  // read both parse their rows at the boundary.
  { from: 'auth', to: 'persistence' },
  // Same reason again, for reviews' own hand-written SQL — every row it reads comes back through
  // rowAs/rowsAs rather than a cast (ADR-0004).
  { from: 'reviews', to: 'persistence' },
  // The outbox producer: insertOutboxRows must run inside the domain write's own transaction
  // (ADR-0007 step 6), so it cannot be lifted to a composition root — reviews calls it directly
  // from submitReview's single commit.
  { from: 'reviews', to: 'jobs' },
];

/**
 * Provider SDKs and the modules allowed to import them outside `apps/*​/src/runtime/**`
 * (ADR-0005: concrete adapters and SDKs live in a composition root, or in the one capability
 * module that owns the adapter). `prefixMatch: true` means the string is a package-name prefix —
 * a scope, or a family like `@opentelemetry/sdk-*` — rather than a complete package name.
 */
const SDK_OWNERS = [
  { sdk: 'bullmq', prefixMatch: false, owners: ['messaging'] },
  { sdk: 'ioredis', prefixMatch: false, owners: ['messaging'] },
  { sdk: 'pino', prefixMatch: false, owners: ['observability'] },
  { sdk: 'pino-pretty', prefixMatch: false, owners: ['observability'] },
  { sdk: '@opentelemetry/sdk-', prefixMatch: true, owners: ['observability'] },
  { sdk: '@opentelemetry/exporter-', prefixMatch: true, owners: ['observability'] },
  // better-auth is held at arm's length: every import of it, subpaths included
  // (better-auth/plugins/magic-link, better-auth/adapters/kysely), lives in packages/auth.
  //
  // ONE NAMED EXCEPTION: the SPA's auth client. ADR-0013 routes auth flows through better-auth's
  // own CLIENT rather than through the oRPC contract, and that client sits beside the oRPC client
  // in `shared/` for the same reason — it is the app's one way to reach a server, not a
  // mode-switched adapter a composition root should own.
  //
  // Scoped to a SINGLE FILE rather than to `apps/app/**` or to a `client` subpath pattern: the
  // browser must never reach the server SDK (`better-auth`, `/plugins`, `/api`, `/adapters` — a
  // Kysely instance, node:crypto and a database handle), and one named path is a boundary a
  // reviewer can check in full. Widening this to a directory is a decision, not a convenience.
  {
    sdk: 'better-auth',
    prefixMatch: true,
    owners: ['auth'],
    alsoAllowedFrom: ['^apps/app/src/shared/session/auth-client\\.ts$'],
  },
  // Radix is the behavioural core under the vendored primitives (focus management, dismissal,
  // ARIA wiring) and a real runtime dependency, unlike the primitives themselves which are
  // copy-in source. Confined to packages/styles: a product composes primitives, it does not reach
  // past them. Published as many small independently-versioned packages, so each is pinned on its
  // own — they do not move in lockstep.
  { sdk: '@radix-ui/', prefixMatch: true, owners: ['styles'] },
];

/**
 * `package.json` `exports` subpaths that are sanctioned public entries BESIDE the barrel
 * (ADR-0001's "one public entry point", with named exceptions). Adding a subpath export without a
 * row here makes `no-cross-module-internals` flag every consumer — deliberately: a second entry
 * point is an architectural decision, not a convenience. Who may import an entry is a separate
 * rule per entry, not this list's concern.
 */
const SANCTIONED_SUBPATH_ENTRIES = [
  // The OTel SDK init entry (ADR-0009), importable only from composition roots.
  { module: 'observability', subpath: 'sdk' },
  // The design-system stylesheet. It cannot ride the barrel — `tsc` neither reads nor emits CSS,
  // so a JS entry point could never expose it — and the consuming app's Tailwind pipeline has to
  // `@import` it directly. Unrestricted by design: any browser bundle may import the token source,
  // which is the point of a token source.
  { module: 'styles', subpath: 'styles.css' },
];

module.exports = {
  TIER_KERNEL,
  TIER_FACADE,
  TIER_CAPABILITY,
  TIER_APP,
  TIER_TOOLING,
  MODULE_FOLDER,
  SANCTIONED_TIER2_EDGES,
  SDK_OWNERS,
  SANCTIONED_SUBPATH_ENTRIES,
};
