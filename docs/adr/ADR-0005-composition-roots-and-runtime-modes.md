---
id: ADR-0005
title: Manual composition roots and three runtime modes, fail-closed outside test
status: accepted
supersedes: []
date: 2026-09-08
---

## Context

Modules depend on capabilities they must not choose: a review pipeline needs to send mail, store
objects and enqueue work, and the moment it names an SES client or a Redis URL it stops being
liftable (ADR-0001) and stops being testable without that infrastructure.

The usual answer is a dependency-injection container. Containers move wiring into a runtime registry
where a missing binding is a runtime failure and the object graph is not readable in any one file.
The alternative — passing dependencies explicitly from one place per deployable — is more verbose
and has the property that the whole graph is one file you can read.

The related question is configuration. A system that silently falls back to a default when a
required secret is missing will run in production with the wrong behaviour and no signal; a system
that refuses to start says so immediately, at the only moment anyone is watching.

## Decision

Every concrete adapter is named in exactly one place per deployable — `apps/*/src/runtime/` — and
the only global switch is `APP_MODE ∈ test | staging | production`, where `test` wires deterministic
stubs with lenient config and `staging`/`production` wire real adapters and fail closed on a missing
required key.

The rules that make it hold:

- Modules declare ports; they never import a provider SDK. Provider SDKs are confined to a
  composition root or to the one capability module that owns that adapter, and dependency-cruiser
  enforces the confinement.
- Every port ships a deterministic stub. A port with no stub cannot be tested without its provider,
  which makes the module untestable in the sense that matters.
- Configuration is composed from per-module slices; nothing reads `process.env` outside the config
  module. Boot in a fail-closed tier validates every slice and refuses to start listing every
  missing key at once, rather than failing on the first one.
- `test` mode is a real mode, not an absence of configuration: it is what a fresh clone runs, and
  the flow works end to end with zero secrets.

## Consequences

The object graph for a deployable is one readable file, and swapping an adapter is a change in that
file rather than a hunt through a registry. Modules stay liftable because none of them names an
implementation. A misconfigured production boot fails immediately with a complete list of what is
missing, which is the difference between a five-minute fix and an afternoon.

The costs are verbosity — every dependency is threaded explicitly, and a new port touches the root
of every app that uses it — and the discipline of writing a stub for each port, which is real work
that pays off only when someone writes the test.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| A DI container (InversifyJS, tsyringe) | Moves wiring into a registry where a missing binding surfaces at runtime and the graph is not readable anywhere. |
| Module-level singletons reading `process.env` | The fastest thing to write and the reason modules stop being liftable; also makes every test depend on ambient environment. |
| A single `NODE_ENV` switch | Conflates "is this a developer machine" with "may this fall back to a stub", which is exactly the conflation that puts a stub in production. |
| Defaults for required production values | Turns a missing secret into wrong behaviour with no signal — the failure mode this decision exists to prevent. |
