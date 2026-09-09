# @repo/extract-module

The ADR-0001 point-3 autonomy-contract CLI (`tier-tooling`, not liftable — ADR-0001's named
exception: tools operate on the repo as data, they are not shipped modules).

## Purpose

Proves a `liftable`-tagged workspace package can be lifted into an unrelated project with only its
declared dependencies — not just that moon's own workspace machinery can resolve it.

## Usage

```
bun run extract-module <name>     # e.g. bun run extract-module jobs
bun run extract-module --all      # every liftable package, one pass
```

`<name>` is a folder name under `packages/*` or `tools/*` (apps are never extraction targets).

## How it works

1. `src/workspace.ts` discovers every `apps/*`, `packages/*`, `tools/*` package (reads each
   `package.json` + `moon.yml` tags — no YAML dependency, a line-scan handles this repo's `tags:`
   block, both bare (`- liftable`) and quoted (`- 'liftable'`) forms).
2. `src/extract.ts` computes the target's transitive `workspace:*` closure and topologically sorts
   it (dependencies first), copies each package's git-tracked files into a fresh temp directory
   **outside the repo** as flat sibling packages — never a bun workspace, since the whole point is
   proving the module survives without moon/bun's workspace machinery.
3. Rewrites each copied `package.json`'s `workspace:*` entries to `file:../<folder>` and each
   `tsconfig.json`'s `extends` path (one level shallower — the temp dir is flatter than the repo),
   pins a local `typescript` devDependency (the monorepo relies on the root package.json's, which
   doesn't travel with a standalone copy).
4. Runs real `bun install` + `tsc` build for every package in the closure, strictly in dependency
   order (a package's `dist/` must exist before anything `file:`-depending on it can resolve its
   types) — then, unless the target declares itself build-only (see below), `vitest run` (unit
   tests only, never `test-integration`) for the target itself.

## The build-only exception

A module that ships source rather than a build — `styles` (ADR-0001) — sets
`"extraction": "build-only"` in its own `package.json`. `extract.ts`'s `extractionModeOf` reads
that field; it is not a hardcoded name list, so the exception is declared by the module that has
it, not maintained here on its behalf. A build-only module still gets a real `bun install` + `tsc`
build in the extracted copy; only the `vitest run` step is skipped for it.

## The honesty rule

An extraction that ran no tests — because the target is build-only, or because its copied tree
carried no unit-test file at all and its own `vitest.config.ts` opts into `passWithNoTests: true`
— reports `pass (build-only)`, never a plain `pass`. `ExtractionResult.ranTests` is what the CLI's
`printResult` keys this off of. A silent gate — a green run that quietly asserted nothing — is
exactly what this tool exists to make impossible, so the report itself must never blur the two.

## Dependencies

None beyond `typescript`/`vitest` (already root-level pins) and the target's own declared
dependencies, resolved for real from the npm registry during extraction. No new third-party
package for this tool itself — see `src/workspace.ts`'s header for why moon.yml tag parsing is
hand-rolled rather than a YAML library dependency.

## Named invariants

- **INV-1**: a `liftable`-tagged package with an unresolvable `workspace:*` dependency, or one
  named by a `moon.yml` this parser can't read, fails loudly (`extract.ts`'s
  `transitiveClosureInBuildOrder`/`rewritePackageJsonForExtraction` both throw with the exact
  culprit name) — never a silent skip. Test: `src/selftest.ts`.
- **INV-2**: an import of a real sibling workspace package that its own `package.json` never
  declares as a `workspace:*` dependency fails the extraction — the dependency closure is built
  from declared dependencies only, so the undeclared package never travels with the copy and the
  extracted `tsc` build cannot resolve it. Test: `src/selftest.ts`'s fixture-backed
  `extractModule` case, fixtures under `test/fixtures/undeclared-import/`.
- **INV-3**: `moon.yml` tag parsing is quote-form-agnostic (bare, single-quoted, and
  double-quoted tags all resolve identically). Test: `src/selftest.ts`, `parseMoonYamlTags` cases.
- **INV-4**: the dependency closure's build order always places every package before anything
  that depends on it, and the extraction target itself last (it is the closure's root). Test:
  `src/selftest.ts`, `transitiveClosureInBuildOrder` cases (diamond-graph fixture).
- **INV-5**: extraction never touches the real repo tree — only git-tracked files are copied
  (`git ls-files`, so a stray local/untracked file can never silently pass or fail an extraction
  differently from CI), and everything happens inside one `mkdtempSync` directory, cleaned up on
  success and left for inspection on failure.
- **INV-6**: a successful extraction that ran no tests is reported as `pass (build-only)`, never
  as a plain `pass`. Test: `src/selftest.ts`, `extractionModeOf` and `copiedTreeHasUnitTests`
  cases.

## Extraction steps (for this package itself)

Not applicable — `tier-tooling`, ADR-0001's named exception. This tool operates on the workspace;
it is not itself a candidate for the proof it performs.

## CI wiring

- `extract-module-selftest` (root `moon.yml`) — this package's own proof, including the
  fixture-backed undeclared-import case above, wired into `moon ci`.
- `extract-module-changed` (root `moon.yml`) — `src/extract-changed.ts`, the real per-PR
  extraction of every module the PR actually touched. Runs with `runInCI: false` locally (it
  resolves changed modules against `origin/main`, which a local `moon ci` may not have fetched);
  CI supplies that precondition and runs the script directly.
- `bun run extract-module --all` (the full matrix over every liftable package) is intentionally
  not wired into per-PR CI — it is a scheduled job's concern, not every PR's.
