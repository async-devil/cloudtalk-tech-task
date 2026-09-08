---
id: ADR-0003
title: TypeScript strict-plus, a curated Biome ruleset, and the folder conventions that go with them
status: accepted
supersedes: []
date: 2026-09-08
---

## Context

Type-level strictness and lint rules are cheap to adopt on day one and expensive to adopt on day
four hundred, because every relaxation becomes load-bearing. The same is true of folder conventions:
the first `utils/` folder is harmless and the fortieth file in it is a dependency magnet nothing can
untangle.

TypeScript's `strict` is a floor, not a ceiling. Three flags outside it matter here:
`exactOptionalPropertyTypes` (an optional property and a property that may be `undefined` are
different things, and conflating them hides real bugs at API boundaries),
`noUncheckedIndexedAccess` (array and record access returns `T | undefined`, which is the truth),
and `verbatimModuleSyntax` (type-only imports are enforced at compile level, which matters when the
bundler erases types without checking).

## Decision

Compile with `strict` plus `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
`noImplicitOverride`, `noFallthroughCasesInSwitch`, `isolatedModules` and `verbatimModuleSyntax`;
lint and format with a single Biome configuration whose every non-default rule carries its rationale
inline; and place code by capability, never by technical role.

The conventions that follow:

- One barrel per module (`src/index.ts`); nested barrels are not a thing; `internal/` is never
  exported.
- No `utils/`, `helpers/`, `misc/`, `common/` — a name that does not say what is inside is a name
  that will accept anything.
- Closed value sets are `const` objects with a derived union type, never a TypeScript `enum`: `enum`
  is non-erasable runtime syntax, interacts badly with `isolatedModules`, and its members do not
  structurally unify with the literal types Zod and oRPC infer.
- Tests, README, config slice and migrations live inside the module they belong to.
- A new capability is a new module wired at a composition root, never a new folder inside an
  existing module.
- `any` and `@ts-ignore` require a written constraint at the site; a gate reports the ones that
  carry none.

## Consequences

The type checker catches the class of bug that otherwise reaches a test or a user — an optional
field written as `undefined`, an array index assumed present, a switch that grew a case. Lint
configuration is one annotated file, so "why is this rule on?" is answerable without archaeology.
Placement questions have answers, which is most of what makes a codebase navigable by someone who
did not write it.

The cost lands on carried and generated code. `noUncheckedIndexedAccess` in particular makes
otherwise-fine array code verbose, and a generated route tree needs an explicit exemption rather
than a relaxed global rule. Rules disabled for a real reason are disabled in one place with the
reason attached, which is the only form of exemption that survives review.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| `strict` alone | Leaves the three highest-value checks off; each of them has caught a real defect in code carried into this repository. |
| ESLint + Prettier | The established pair, at the cost of two tools, a plugin graph, and a slower pass over the whole tree. Biome does both in one binary with one config. |
| Relaxed types with heavier runtime validation | Duplicates the type system at runtime and pays for it on every request; ADR-0004 already validates at boundaries, which is where the untrusted data is. |
| Allowing `enum` | Familiar to most contributors, and it breaks erasability and does not unify with inferred literal types — the two properties this codebase actually depends on. |
