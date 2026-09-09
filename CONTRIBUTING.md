# Contributing

## The documentation contract

Two kinds of document, kept strictly separate by intent:

- [`docs/adr/`](docs/adr/) — **decision records**. A decision and its trade-offs. *Why was it built
  this way.*
- [`docs/tasks/`](docs/tasks/) — **implementation tasks**. A unit of work and its acceptance
  criteria. *What needs doing, and how we know it is done.*

Do not mix them. A record containing a to-do list, or a task arguing an architectural trade-off, is
in the wrong folder — split it.

**Naming.** `docs/adr/ADR-XXXX-kebab-case-title.md`, `docs/tasks/TASK-XXXX-kebab-case-title.md`.
Ids are sequential per folder, zero-padded to four digits, never reused or renumbered.

**Frontmatter.** A record carries `id`, `title`, `status` (`proposed` | `accepted` | `superseded` |
`rejected`), `supersedes`, `date`. A task carries `id`, `title`, `status` (`draft` | `ready` |
`in-progress` | `done`), `adr`, `date`.

**Body sections, in this order.** A record: Context → Decision → Consequences → Alternatives
considered, where Decision is one sentence. A task: Scope → Out of scope → Acceptance criteria →
Notes, where the criteria are a testable checklist with no adjectives in it.

**Lifecycle.** A record goes `proposed` → `accepted` or `rejected`, and `accepted` → `superseded`
only when a new record replaces it and names it in `supersedes`. A task goes `draft` → `ready` →
`in-progress` → `done`, and only one task is `in-progress` at a time.

**`docs/README.md` is generated.** Run `bun run docs-index -- --write` after adding or changing any
record or task. CI fails on a stale index, and the same check validates the schema above.

Never change a record's status without being asked to. If a decision is needed mid-task that no
record covers, stop and propose a new one with `status: proposed` rather than deciding silently in
code.

## How to add a module

A new capability is a new `packages/<name>` wired at a composition root — never a new folder inside
an existing module (ADR-0003).

1. Create the package with the standard shape: `src/index.ts` as the only barrel, `src/internal/`
   for everything not exported, `test/`, `moon.yml`, `tsconfig.json`, `README.md`.
2. Register the name in `tools/arch-checks/src/module-registry.cjs`, under its tier. This is
   deliberately a reviewed edit: a new module is an architectural change, and that file is where a
   reviewer sees it.
3. If it needs an edge to another capability module, add it to `SANCTIONED_TIER2_EDGES` **with the
   reason**. An unexplained entry there is a change request.
4. If it defines a port, ship a deterministic stub with it. A port with no stub makes every consumer
   untestable without the real provider (ADR-0005).
5. Write the README: purpose including a "when NOT to use this" line, public contract, dependencies
   with a reason each, config slice, named invariants each mapped to the test that proves it, and
   the telemetry it emits.
6. Confirm it lifts: `bun run extract-module <name>`.

## Commits and branches

```
<type>(<scope>): <imperative summary, 72 chars or fewer>

[body: what and why, constraints, the record or task it implements]
```

`type` is one of `feat | fix | chore | docs | refactor | test | ci`. `scope` is a module or app
name, or `repo` for anything cross-cutting. Imperative mood — "add outbox parking", not "added" or
"adds". One logical change per commit.

Reference decisions rather than restating them: `Implements ADR-0007 (outbox-driven projection).`
When a task is completed, flip its status to `done` and name its id in the commit.

Branches are `<type>/<scope>-<slug>`, short-lived, deleted on merge. Only `main` is long-lived.

**No generated-by or co-author trailers.** The diff is the author.

## Pull requests

Small and single-purpose — if the description needs an "and", split it. Squash-merge, and the PR
title becomes the commit subject, so it follows the commit format.

Reviewers check against the records, not personal taste; a taste argument ends with "which record?".
A structural change with no record reference in its description is an automatic change request.
Never merge on red or bypassed gates.

## Verification standard

Adding a gate means adding its fixtures: a red one it must catch and a green one it must pass.
Adding a test for a security or durability property means mutating the behaviour, watching the test
fail, and restoring it — a test that passes when the behaviour is broken is worse than no test,
because it stops anyone from writing the real one (ADR-0010).
