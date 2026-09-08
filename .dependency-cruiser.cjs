/**
 * The dependency-cruiser ruleset — this repository's boundary law in machine-checkable form.
 * Enforces ADR-0001 (tier direction, the module autonomy contract, one public entry point),
 * ADR-0003 (folder structure, frontend slice isolation) and ADR-0005 (adapters and provider SDKs
 * confined to composition roots).
 *
 * CommonJS, not this workspace's default ESM. ADR-0002 scopes ESM-only to *shipped* code under
 * `apps|packages|tools/*​/src`; this is tooling config that dependency-cruiser's own loader reads
 * with `require()` — a documented exception, not a violation.
 *
 * Rule syntax comes from dependency-cruiser's docs at the pinned tag only:
 *   https://github.com/sverweij/dependency-cruiser/blob/v18.1.0/doc/rules-reference.md
 *   https://github.com/sverweij/dependency-cruiser/blob/v18.1.0/doc/options-reference.md
 *
 * ---------------------------------------------------------------------------------------------
 * THREE-FORM PATH MATCHING — the pitfall this file is shaped around, verified empirically rather
 * than quoted. A single `import ... from '@repo/<name>/...'` inside a Bun workspace can resolve to
 * any of three on-disk shapes depending on `preserveSymlinks` (a dependency-cruiser option,
 * default `false`) and on build state:
 *   1. the real workspace source   `packages/<name>/src/**`       — the default realpaths through
 *      the workspace's node_modules symlink
 *   2. the node_modules symlink    `node_modules/@repo/<name>/**` — `preserveSymlinks: true`, or
 *      any resolver reporting the symlink rather than its target
 *   3. the bare specifier itself   `@repo/<name>(/...)`           — unresolved: before `dist/`
 *      exists, or a subpath the target's `exports` map does not expose
 * Every rule below that names a workspace module matches all three forms on the `to` side. The
 * `from` side never needs forms 2 and 3: it is always the physical file being looked at.
 *
 * PARSER NOTE. dependency-cruiser 18.1.0 parses TypeScript only when a `typescript` in range
 * `>=2.0.0 <7.0.0` OR an `@swc/core >=1.0.0 <2.0.0` resolves (its `src/meta.cjs`
 * `supportedTranspilers`). This repo pins `typescript@7.0.2`, outside that range, so `@swc/core`
 * is installed solely as dependency-cruiser's TypeScript parser. `depcruise --info` must show
 * `.ts ✔`; the `deep-import-ts` fixture keeps that from regressing silently. A hollow gate here
 * would unenforce the whole boundary law exactly when real `.ts` modules land.
 * ---------------------------------------------------------------------------------------------
 */
'use strict';

const {
  TIER_KERNEL,
  TIER_FACADE,
  TIER_CAPABILITY,
  TIER_APP,
  TIER_TOOLING,
  MODULE_FOLDER,
  SANCTIONED_TIER2_EDGES,
  SDK_OWNERS,
  SANCTIONED_SUBPATH_ENTRIES,
} = require('./tools/arch-checks/src/module-registry.cjs');

const ALL_MODULE_NAMES = [
  ...TIER_KERNEL,
  ...TIER_FACADE,
  ...TIER_CAPABILITY,
  ...TIER_APP,
  ...TIER_TOOLING,
];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- three-form path builders ----------------------------------------------------------------

function moduleSourceForm(name) {
  const folder = MODULE_FOLDER.get(name);
  if (!folder) {
    throw new Error(`module-registry.cjs: "${name}" has no MODULE_FOLDER entry`);
  }
  return `^${folder}/${escapeRegExp(name)}/`;
}
function moduleNodeModulesForm(name) {
  return `^node_modules/@repo/${escapeRegExp(name)}(?:/|$)`;
}
function moduleBareSpecifierForm(name) {
  return `^@repo/${escapeRegExp(name)}(?:/|$)`;
}
function moduleThreeForms(names) {
  return names.flatMap((name) => [
    moduleSourceForm(name),
    moduleNodeModulesForm(name),
    moduleBareSpecifierForm(name),
  ]);
}

// A module's own root, `from`-side only (the file being scanned is always a real source path).
function moduleRootPath(name) {
  const folder = MODULE_FOLDER.get(name);
  return `^${folder}/${escapeRegExp(name)}/`;
}

// Any module's public barrel, however it resolved — the one thing a cross-module import may reach.
const BARREL_SUFFIX_PATTERN = '/(?:src|dist)/index\\.(?:ts|js|mjs|cjs|d\\.ts)$';

// --- rule builders -----------------------------------------------------------------------------

function tierDirectionRule(sourceModules, extraAllowedModules) {
  const allowed = Array.from(new Set([...sourceModules, ...extraAllowedModules]));
  return {
    name: 'tier-direction',
    severity: 'error',
    comment:
      'ADR-0001: kernel -> facade -> capability -> app, and tooling operates on the repo as data. ' +
      `Allowed targets for [${sourceModules.join(', ')}]: [${allowed.join(', ') || 'nothing'}]. ` +
      'Coarse direction is also enforced by moon tag constraints in .moon/workspace.yml; this is ' +
      'the fine-grained, per-import proof.',
    from: { path: sourceModules.map(moduleRootPath) },
    to: {
      path: moduleThreeForms(ALL_MODULE_NAMES),
      pathNot: moduleThreeForms(allowed),
    },
  };
}

const tierDirectionRules = [
  tierDirectionRule(TIER_KERNEL, []),
  tierDirectionRule(TIER_FACADE, TIER_KERNEL),
  tierDirectionRule(TIER_CAPABILITY, [...TIER_KERNEL, ...TIER_FACADE]),
  tierDirectionRule(TIER_APP, [...TIER_KERNEL, ...TIER_FACADE, ...TIER_CAPABILITY]),
  tierDirectionRule(TIER_TOOLING, []),
];

function sanctionedTargetsFor(moduleName) {
  return SANCTIONED_TIER2_EDGES.filter((edge) => edge.from === moduleName).map((edge) => edge.to);
}

const tier2UnsanctionedRules = TIER_CAPABILITY.map((name) => {
  const sanctioned = sanctionedTargetsFor(name);
  return {
    name: 'no-tier2-unsanctioned',
    severity: 'error',
    comment:
      'ADR-0001: capability-to-capability edges are forbidden unless enumerated in ' +
      'SANCTIONED_TIER2_EDGES (tools/arch-checks/src/module-registry.cjs). ' +
      `'${name}' is currently sanctioned to depend on: [${sanctioned.join(', ') || 'nothing'}].`,
    from: { path: moduleRootPath(name) },
    to: {
      path: moduleThreeForms(TIER_CAPABILITY),
      pathNot: moduleThreeForms([name, ...sanctioned]),
    },
  };
});

const noCrossModuleInternalsRule = {
  name: 'no-cross-module-internals',
  severity: 'error',
  comment:
    'ADR-0001 and ADR-0003 (one public entry point; internals under internal/; a single barrel): ' +
    "a cross-module import must resolve through the target's public barrel — bare `@repo/<name>` " +
    "or its resolved src|dist/index.* — never a path into another module's src/**, and least of " +
    'all src/internal/**. Name-agnostic by design: it matches any apps|packages|tools/<name>/ ' +
    'folder via a capturing group rather than the registry, so it also protects a brand-new ' +
    'module before anyone remembers to register it. Same-module deep access is fine — that is ' +
    'what internal/ is for — and is matched via the `from` group back-reference.',
  from: { path: '^(?:apps|packages|tools)/([^/]+)/' },
  to: {
    path: [
      '^(?:apps|packages|tools)/[^/]+/src/', // form 1: another module's real source tree
      '^node_modules/@repo/[^/]+/', // form 2: another module's node_modules symlink tree
      '^@repo/[^/]+/', // form 3: bare specifier WITH a subpath (a deep import)
    ],
    pathNot: [
      '^(?:apps|packages|tools)/$1/', // same module
      BARREL_SUFFIX_PATTERN, // any module's barrel, however it resolved
      // Sanctioned subpath entries, in the same three forms. WHO may import one is a separate
      // rule per entry, not this rule's concern.
      ...SANCTIONED_SUBPATH_ENTRIES.flatMap(({ module, subpath }) => [
        `^@repo/${module}/${subpath}$`,
        `^packages/${module}/(?:src|dist)/${subpath}\\.(?:ts|js|mjs|cjs|d\\.ts)$`,
        `^node_modules/@repo/${module}/(?:src|dist)/${subpath}\\.(?:ts|js|mjs|cjs|d\\.ts)$`,
        // Extension-carrying subpaths such as `styles/styles.css` — a non-JS asset entry, which
        // `tsc` neither reads nor emits, so the two forms above can never match it. Harmless for
        // extensionless entries like `observability/sdk`: no resolver reports that path shape.
        `^packages/${module}/(?:src|dist)/${subpath}$`,
        `^node_modules/@repo/${module}/(?:src|dist)/${subpath}$`,
      ]),
    ],
  },
};

const noCircularRule = {
  name: 'no-circular',
  severity: 'error',
  comment:
    'ADR-0001: no circular dependencies, workspace-wide. A structural rule — it matches by graph ' +
    'topology via `to.circular`, so the three-form pitfall does not apply; there is no specific ' +
    'module name to match forms against.',
  from: { pathNot: '^(?:node_modules)' },
  to: { circular: true },
};

// Frontend slice isolation (ADR-0012). Slices are folders inside ONE workspace module, never
// separate `@repo/*` packages, so imports between them are always relative source paths — the
// node_modules and bare-specifier forms of the pitfall do not arise here.
const feSliceIsolationRules = [
  {
    name: 'fe-slice-isolation',
    severity: 'error',
    comment:
      'ADR-0012: shared/ must never import routes or features. The slice graph is one-directional ' +
      '— shared is the app kernel, and a kernel that reaches back into a feature is not one.',
    from: { path: '^apps/app/src/shared/' },
    to: { path: ['^apps/app/src/routes/', '^apps/app/src/features/'] },
  },
  {
    name: 'fe-slice-isolation',
    severity: 'error',
    comment:
      'ADR-0012: a feature never imports another feature, and never imports routes. Code two ' +
      'features need moves to shared/ — that is what makes a feature folder deletable.',
    from: { path: '^apps/app/src/features/([^/]+)/' },
    to: {
      path: ['^apps/app/src/routes/', '^apps/app/src/features/'],
      pathNot: '^apps/app/src/features/$1/',
    },
  },
];

const adaptersAndSdkOnlyInRuntimeRules = SDK_OWNERS.map(
  ({
    sdk,
    prefixMatch,
    owners,
    // Optional, and deliberately spelled as exact file paths where used: extra `from` locations
    // sanctioned for this SDK beyond a composition root and the owning module.
    alsoAllowedFrom = [],
  }) => {
    const escaped = escapeRegExp(sdk);
    const bareForm = prefixMatch ? `^${escaped}` : `^${escaped}(?:/|$)`;
    const nodeModulesForm = `^node_modules/${escaped}`;
    return {
      name: 'adapters-and-sdk-only-in-runtime',
      severity: 'error',
      comment:
        'ADR-0005 (concrete adapters and provider SDKs live only in apps/*​/src/runtime/**, or in ' +
        `the one capability module that owns the adapter): '${sdk}' may be imported only from ` +
        `apps/*​/src/runtime/** or from [${owners.map((owner) => `packages/${owner}`).join(', ')}] ` +
        '(see SDK_OWNERS in tools/arch-checks/src/module-registry.cjs). No source-vs-symlink ' +
        'ambiguity applies: third-party packages are never workspace-local source, so only the ' +
        'node_modules and bare-specifier forms are relevant.',
      from: {
        pathNot: ['^apps/[^/]+/src/runtime/', ...owners.map(moduleRootPath), ...alsoAllowedFrom],
      },
      to: { path: [bareForm, nodeModulesForm] },
    };
  },
);

const observabilitySdkEntryRule = {
  name: 'observability-sdk-entry-only-in-runtime',
  severity: 'error',
  comment:
    'ADR-0009: the OTel SDK is wired exactly once, in a composition root. Import ' +
    '@repo/observability/sdk only from apps/*​/src/runtime/**; every module uses the facade entry, ' +
    'which touches @opentelemetry/api and nothing else. Three-form matching like every other rule.',
  from: {
    pathNot: ['^apps/[^/]+/src/runtime/', '^packages/observability/'],
  },
  to: {
    path: [
      '^@repo/observability/sdk$',
      '^packages/observability/(src|dist)/sdk',
      '^node_modules/@repo/observability/(src|dist)/sdk',
    ],
  },
};

const noAppRowSchemaRule = {
  name: 'no-app-row-schemas',
  severity: 'error',
  comment:
    'ADR-0003 and ADR-0011: an app must not declare its own row schemas — the storage shape lives ' +
    'in @repo/entities and is imported through @repo/persistence, never restated. Forbidding an ' +
    "app's db/ folder from importing zod is the structural proxy for that: a row schema is " +
    'exactly what a zod import there would build. The migrate CLI needs no zod, so everything ' +
    'that legitimately belongs under db/ still passes.',
  // `to` matches zod as a full path segment ANYWHERE under node_modules, not just at the root:
  // Bun installs into a content-addressed store, so zod realpaths to
  // `node_modules/.bun/zod@<ver>/node_modules/zod/index.cjs`. A `^node_modules/zod` anchor would
  // silently never match that layout, hollowing this gate. The bare-specifier form is kept for the
  // unresolved case. The trailing slash in `zod/` avoids matching `zod-*` packages.
  from: { path: '^apps/[^/]+/src/db/' },
  to: { path: ['^zod(?:/|$)', '(^|/)node_modules/zod/'] },
};

module.exports = {
  forbidden: [
    ...tierDirectionRules,
    ...tier2UnsanctionedRules,
    noCrossModuleInternalsRule,
    noCircularRule,
    ...feSliceIsolationRules,
    ...adaptersAndSdkOnlyInRuntimeRules,
    observabilitySdkEntryRule,
    noAppRowSchemaRule,
  ],
  options: {
    // The rule self-test fixtures are deliberate violations; `run-fixture-tests.ts` targets them
    // directly with a per-fixture `baseDir`, at which point their reported paths no longer contain
    // `test/fixtures`. The second pattern is an app's bundler output: `apps/app/dist/**` holds
    // content-hashed filenames that change on every build and a rolled-up copy of source already
    // cruised properly at `apps/app/src/**`. Cruising it buys nothing and costs a real flake —
    // `moon ci` runs `app:build` and `root:depcruise` concurrently, the cruise walks
    // `dist/assets/index-<hash>.js`, the build replaces it mid-walk, and dep-cruiser dies with
    // ENOENT. Scoped to `apps/*` on purpose: `packages/*/dist` is plain `tsc` output with stable
    // names and stays in scope.
    exclude: { path: ['(^|/)test/fixtures/', '^apps/[^/]+/dist/'] },
    // doNotFollow, NOT exclude. Bun's workspace linking creates real symlinked directories
    // (packages/config/node_modules/@repo/kernel -> ../../kernel) that the directory scan walks as
    // first-class source, mis-attributing kernel's own internal imports to the dependent package.
    // doNotFollow stops PARSING modules under node_modules — killing those false positives — while
    // keeping them visible as `to` endpoints, which the SDK rules' node_modules matching depends
    // on. A plain exclude would silently disarm those rules for every installed SDK.
    doNotFollow: { path: '(^|/)node_modules/' },
  },
};
