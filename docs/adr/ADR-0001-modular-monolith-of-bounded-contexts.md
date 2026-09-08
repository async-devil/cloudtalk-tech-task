---
id: ADR-0001
title: A modular monolith of bounded-context modules, with autonomy as a CI-tested contract
status: accepted
supersedes: []
date: 2026-09-08
---

## Context

A product-review system is small today and has an obvious growth path: reviews attract moderation,
moderation attracts a workflow, ratings attract aggregation and caching, and each of those wants to
scale on its own schedule. The structure chosen now decides whether that growth is absorbed or
fought.

Two forces shape the ruling. **Structure:** decomposition by technical layer
(controllers/services/repositories) couples everything to everything — no slice of a layered
monolith can be lifted, deleted or owned independently, and growth concentrates in grab-bag layers.
Decomposition by *capability* preserves the option: each module is a bounded context that could,
if a concrete force ever demanded it, become a standalone package or a service. **Proof:**
import-boundary rules alone leave modularity aspirational. Rules that nothing exercises decay
silently — a boundary law CI cannot falsify is a wish, not an architecture.

Distribution is deliberately deferred. Microservices buy independent deploys at an operational cost
this system has nobody to pay; monolith-first is the standard position for this size of product.

## Decision

Build one deployable composed of workspace modules, each a bounded context, layered
kernel → facades → capability modules → composition roots, where cross-module communication uses
only typed ports or events and every module's independence is proven by a CI job that copies it out
of the repository and builds and tests it standing alone.

The autonomy contract, six points, each machine-checked:

1. **One public entry point** per module (the `exports` map); no deep imports; internals under
   `internal/`.
2. **Dependencies** are declared third-party packages plus kernel/facade-tier workspace packages.
   Capability-to-capability edges are enumerated in the ruleset; everything else is forbidden.
3. **The extraction test** — `tools/extract-module` copies a module plus its declared workspace
   dependency closure to a temporary directory outside the workspace, rewrites the workspace ranges
   to file references, materializes third-party versions at the lockfile's pins, and runs
   `bun install && build && test` there. An undeclared import fails the run, and that failure is
   half the tool's value.
4. **A README per module** stating purpose, public contract, dependencies, config slice, named
   invariants mapped to their tests, and telemetry.
5. **Instrumentation only through the observability facade** (ADR-0009).
6. **Adapter substitution with zero core edits**, proven by each module's stub-backed tests
   (ADR-0005).

Apps are a named exception to point 3: they are deployables, not liftable. `styles` ships source
rather than a build, so it extracts build-only.

## Consequences

Every module is a candidate for extraction and the dependency graph is explicit and greppable —
"can I lift this?" is answered by CI rather than by opinion. Module READMEs stay truthful by force,
because the extraction report is the checkable version of their dependency claims. Spans and
metrics scope naturally per module.

The costs are real: more manifests and config per module, a two-channel rule contributors must
learn, and extraction time in CI. Kernel-tier changes fan out across the graph. Reversing the
structure is expensive; reversing the tooling that proves it is not.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Layered monolith (controllers/services/repositories) | Nothing is liftable and growth concentrates in grab-bag layers — it fails the extendability the brief asks for. |
| Microservices from the start | Independent deploys bought with operational cost that no force here justifies. |
| A single-package application | Simplest to start, but boundaries are exactly what this design is for. |
| Boundary rules with no extraction proof | Cheap, and the failure mode is silent: the rules stay green while the claim they encode stops being true. |
| Publishing modules to a registry | The strongest proof available, at the price of publish ceremony for code with one consumer. Extraction gives the same signal without it. |
