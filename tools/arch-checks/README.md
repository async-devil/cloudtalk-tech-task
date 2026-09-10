# @repo/arch-checks

The repository's machine-checked boundary and hygiene law (`tier-tooling`, not liftable —
ADR-0001's named exception, the same one `tools/extract-module` carries: this package operates on
the repo as data, it is not a shipped module).

## Purpose

Every "the record enforces X" line in `CLAUDE.md` and the ADRs names a machine check, and this
package (plus the `.dependency-cruiser.cjs` ruleset it feeds data to) is where almost all of those
checks live. Each gate is a small, close-to-zero-dependency script that scans real source and exits
non-zero on a violation; `moon ci` runs every one of them as a `root:*` task, and one of the gates
(`gate-integrity`) exists specifically to make quietly dropping another one a loud, reviewable diff
rather than a silent one (ADR-0010).

**When NOT to use this.** These are verification scripts, not a place for product behaviour: a gate
here may read `src/` across the whole workspace, but it must never be imported BY product code, and
it takes no workspace dependency itself (`tier-tooling` sits outside ADR-0001's kernel → facade →
capability → app direction entirely, and `.dependency-cruiser.cjs`'s `tier-direction` rule gives it
zero allowed targets). A rule about what a module's OWN behaviour should be belongs in that
module's tests, not in a new scanner here.

## Gates

| Script | Enforces | Record |
|---|---|---|
| `run-depcruise.ts` | Invokes dependency-cruiser (JS API, not the CLI — see the file header for why) against `.dependency-cruiser.cjs`: tier direction, one public entry point, sanctioned capability-to-capability edges, no circular imports, frontend slice isolation, adapter/SDK confinement to composition roots. | ADR-0001, ADR-0003, ADR-0005, ADR-0012 |
| `run-fixture-tests.ts` | dependency-cruiser's own red/green proof: every named rule in `.dependency-cruiser.cjs` fires on a `test/fixtures/violations/*` tree and stays clean on the matching `ok/*` tree. | ADR-0001 |
| `no-core-logging.ts` | "Handled once, at a boundary": `logger.error(`/`logger.fatal(`/`console.*` outside a small named set of boundary files and subtrees is a violation. Info/debug logging is out of scope by design. | ADR-0009 |
| `no-cjs-exports-map.ts` | No shipped `package.json` `exports` map may carry a `require` condition or a `.cjs` target, and no `.cjs` file may exist outside the named exemption list (tool config `require()`'d synchronously). | ADR-0002 |
| `unjustified-any-gate.ts` | Every `as any` / `@ts-ignore` / `@ts-expect-error` needs a same-line-or-above comment naming the constraint, or a `biome-ignore lint/suspicious/noExplicitAny:` reason. Generated (`*.gen.ts`) files are exempt. | ADR-0003 |
| `telemetry-map.ts` | Every span/instrument a module's `src/` emits has a `## Telemetry` README line, and every declared line names something actually emitted — both directions, per module, with a dated `(amends <link>, YYYY-MM-DD: <reason>)` marker as the sanctioned escape hatch for a recorded divergence. | ADR-0009 |
| `migration-ddl.ts` | Hand-written migration SQL follows the naming/structure conventions: identifier length, constraint naming and presence, no `IF NOT EXISTS`, no enum types, root-vs-runner migration discipline, timestamp/boolean column shape, the `updated_at` trigger requirement, storage-parameter defaults, and a cross-check against the ADR-0006 data-lifecycle registry (`data-lifecycle-registry.cjs`). Twenty named rules in the `RULE` catalog, one per ADR bullet. | ADR-0006, ADR-0011 |
| `gate-integrity.ts` | No commented-out step inside a workflow's `jobs:` mapping, and every job id `required-gates.json` names for a workflow file actually exists in it (and vice versa: a required workflow file that vanished entirely is itself a violation). | ADR-0010 |
| `docs-index.ts` | Generates and validates `docs/README.md`: frontmatter schema per document kind, frozen section order, sequential per-folder ids, and whether an `adr:`/`supersedes` reference resolves to a record that exists. `--write` regenerates the index; with no flag it only checks. | The documentation contract (`CONTRIBUTING.md`), ADR-0015 |
| `typecheck-tests.ts` | Every package's `test/` and `test-integration/` directories are typechecked. The inherited `typecheck` task structurally cannot: a package's own `tsconfig.json` carries `include: ["src"]` because that same config drives `build`. vitest transpiles rather than typechecks, and a container suite may not run locally at all — so before this gate, a type error in a durability harness reached CI as a runtime failure in a file nothing had compiled. Per-package from inside one; a repo-wide sweep when given a root. | ADR-0010 |
| `selftest.ts` | The gates' own gate: runs `no-core-logging`, `no-cjs-exports-map`, `unjustified-any-gate`, `telemetry-map`, `typecheck-tests` and `gate-integrity` each against a clean fixture (must pass) and a violating one (must fail) — see Fixture honesty below for the two gates this excludes. | ADR-0010 |
| `run-integration-suite.ts` | Not an architecture rule: the one "is Docker reachable" decision every package's `test-integration` task shares — skip loudly with no daemon locally, hard-fail with no daemon in CI, so a Testcontainers suite can never quietly not run. | — |
| `module-registry.cjs` | Not a gate: the registry both `.dependency-cruiser.cjs` and `depcruise-completeness` build their rules from — tiers, sanctioned tier-2 edges, third-party SDK ownership, sanctioned subpath exports. | ADR-0001, ADR-0003 |
| `data-lifecycle-registry.cjs` | Not a gate: the `schema.table` → lifecycle-class map `migration-ddl.ts` reads to enforce the evidence-needs-a-horizon rule and the inverse staleness check. | ADR-0006 |
| `workspace-roots.ts` | Not a gate: the one derivation of "which top-level folders hold product source" / "which hold every workspace member," shared by every scanner above so a new `workspaces` glob is covered by all of them the moment it is added, with nothing to remember to update by hand. | ADR-0001 |

Every scanner above (except the two files that wrap dependency-cruiser) follows the same shape,
stated once in `no-core-logging.ts`'s header and repeated in each sibling's: zero npm dependencies,
plain line-matching over `packages/*/src/**` and `apps/*/src/**`, never a full TypeScript/AST
parse — narrow enough that a general parser would buy correctness this repo's actual file shapes
do not need.

## Usage

Each checker takes an optional directory/argument override so a fixture runner or a future caller
can point it away from the real repo; with none, it checks the real tree and is what its
`root:*` moon task runs:

```
bun tools/arch-checks/src/run-depcruise.ts
bun tools/arch-checks/src/no-core-logging.ts [repoRoot]
bun tools/arch-checks/src/no-cjs-exports-map.ts [repoRoot]
bun tools/arch-checks/src/unjustified-any-gate.ts [repoRoot]
bun tools/arch-checks/src/telemetry-map.ts [repoRoot]
bun tools/arch-checks/src/migration-ddl.ts [repoRoot]
bun tools/arch-checks/src/typecheck-tests.ts [repoRoot]
bun tools/arch-checks/src/gate-integrity.ts [workflowsDir] [requiredGatesPath]
bun tools/arch-checks/src/docs-index.ts [--write]
bun tools/arch-checks/src/selftest.ts
bun tools/arch-checks/src/run-fixture-tests.ts
```

`run-integration-suite.ts` is not invoked directly; each package's `test-integration` moon task
runs it from that package's own directory (it reads `process.cwd()`).

## Fixture honesty

`selftest.ts` proves six gates on both a clean and a deliberately violating fixture —
`no-core-logging`, `no-cjs-exports-map`, `unjustified-any-gate`, `telemetry-map`,
`typecheck-tests` and `gate-integrity`. The violating half is the one that matters, since a rule
that silently stopped matching looks exactly like a codebase that stopped violating it.
(`depcruise` has its own equivalent proof in `run-fixture-tests.ts`.) Two gates ship no such
proof, and both absences are stated plainly rather than glossed over:

- **`migration-ddl.ts`** ships no fixture tree. It is exercised only against the repository's real
  migrations by the `root:migration-ddl` task — weaker than a red fixture, and `selftest.ts`'s own
  header says so in exactly those words.
- **`docs-index.ts`** ships no fixture tree either, and for one more reason beyond the first: it
  takes no root argument at all (it resolves `docs/` from its own module URL), so there is no way
  to point it at a fixture tree without adding a parameter that would exist only for the test. Its
  negative cases — a section renamed out of order, an `adr:` pointing at a record that does not
  exist, an id renumbered into a gap, a hand-edited `docs/README.md` — are documented in
  `CONTRIBUTING.md`'s "Changing the checker" as checks performed by hand, against the real `docs/`
  tree, restored afterward.

Neither gap is scheduled to close by this README's writing; it is recorded so the next person
changing either checker knows what proof they are, and are not, inheriting.

## Dependencies

`dependency-cruiser@18.1.0` (a devDependency; only `run-depcruise.ts` and `run-fixture-tests.ts`
import it, via its documented JS API rather than its CLI — the CLI's Node-version floor would make
this gate fail on a reason unrelated to the code it checks). Every other script in this package
takes no npm dependency at all: the zero-dependency, hand-rolled-scanner shape is deliberate,
argued once in `no-core-logging.ts`'s header, so these gates never depend on a library's own bugs
or breaking upgrades to keep enforcing a rule.

## Named invariants

- **INV-1** — Every fixture-backed checker (`no-core-logging`, `no-cjs-exports-map`,
  `unjustified-any-gate`, `telemetry-map`, `gate-integrity`) reports zero violations against its
  own clean fixture and at least one against its own violating fixture. Test: `src/selftest.ts`.
- **INV-2** — Every named rule in `.dependency-cruiser.cjs` fires on its own
  `test/fixtures/violations/*` tree and stays clean on the matching `ok/*` tree. Test:
  `src/run-fixture-tests.ts`.
- **INV-3** — `gate-integrity`'s clean case is the real `.github/workflows/` directory and the real
  `required-gates.json`, not a synthetic stand-in — the one fixture case in `selftest.ts` proven
  against the actual thing it protects rather than a fixture imitating it. Test: `src/selftest.ts`
  (the `gate-integrity` case).
- **INV-4** — `migration-ddl.ts` and `docs-index.ts` carry no fixture-backed proof of their own —
  see Fixture honesty above. This is the same honesty rule `tools/extract-module`'s README states
  for its own reporting (a silent gate is exactly what these tools exist to make impossible),
  applied here to the fact of a missing proof rather than to a misleading pass/fail label.

## Extraction steps

Not applicable — `tier-tooling`, ADR-0001's named exception. This package is the boundary law's own
enforcement machinery; it is not itself a candidate for the extraction proof it helps define for
every other module.

## CI wiring

Every gate above (excluding `run-integration-suite.ts` and `typecheck-tests.ts`, which are
per-package rather than repo-wide) is a `root:*` task in the repository root `moon.yml`, run by
`bun moon ci`: `depcruise`, `depcruise-selftest`, `arch-checks-selftest`, `docs-check`,
`gate-integrity`, `no-core-logging`, `unjustified-any-gate`, `no-cjs-exports-map`,
`migration-ddl`, `telemetry-map`.

`typecheck-tests` is an INHERITED task (`.moon/tasks/all.yml`), not a `root:*` one, for the same
reason `test-integration` is: it needs each package's upstream `^:build` to have run, which only a
per-project task can express — a root task has no upstream to wait on. It is still run by
`bun moon ci`, once per project, and reported under that project's name.
`tools/arch-checks/required-gates.json` currently requires the job ids `ci`, `docs-check` and
`gate-integrity` to exist in `.github/workflows/ci.yml` — dropping one from that workflow without
also editing the manifest is what `gate-integrity` itself is built to catch.
