---
id: ADR-0002
title: Bun as runtime and package manager, moon as the task graph, ESM only
status: accepted
supersedes: []
date: 2026-09-08
---

## Context

The repository is a multi-package workspace: ten libraries, two applications, two tool packages.
It needs a runtime, a package manager, and something that knows which tasks depend on which so a
full check does not mean rebuilding everything.

Node with npm workspaces is the default answer and works. Bun collapses three tools into one — it
is the runtime, the package manager, and the test-adjacent tooling — and its install is fast enough
that a cold clone to a green chain is a coffee, not a lunch. Its risk is maturity: a library that
assumes Node internals can misbehave, and the ecosystem's assumption is still Node.

Task orchestration is a separate question. Without a task graph, "check everything" is a shell
script that runs every task in every package on every change, and CI time grows linearly with the
repository.

## Decision

Bun is the runtime and package manager, pinned to one version in `.moon/toolchains.yml`; moon owns
the task graph, with tasks declared explicitly rather than inferred from `package.json` scripts; and
every package is ESM only.

Consequences of the pin worth stating: CI reads the version out of that file and asserts the runtime
that actually landed matches it, because a version resolved by an action's own defaults is not a
pin. Task defaults are inherited by product projects only — tool projects declare their own, so the
defaults never break on a package that has no build.

ESM-only has one documented exception: `.dependency-cruiser.cjs` and the module registry it reads,
which dependency-cruiser's own loader requires synchronously at config-load time.

## Consequences

One toolchain to install and one version to pin. Task-graph awareness means a change to the SPA does
not rebuild the job spine, and `moon ci` is affected-scoped by default. Explicit task declaration
means the answer to "what does CI run?" is a file, not an inference.

The costs: Bun's ecosystem edges are real and this repository has already met some — anything that
wants the TypeScript compiler API, for instance, needs checking against the pinned version before
being assumed available. A second orchestration tool is a second thing to learn. And moon's affected
detection resolves the default branch through git, so CI needs full history rather than a shallow
checkout — a shallow clone fails for a reason unrelated to the code.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Node + npm workspaces, no task graph | Works, and every check runs everything. CI time grows with the repository rather than with the change. |
| Node + pnpm + Turborepo | A solid combination; three tools where Bun plus moon is two, and no advantage that shows up at this size. |
| Bun with `bun test` as the runner | Rejected in ADR-0010: the assertion and mocking surface is thinner, and container-backed suites need the ecosystem Vitest has. |
| Nx | More capability than this repository has questions for, and its generators pull toward conventions this design does not want. |
