---
id: ADR-0012
title: A React SPA with slice isolation over a token-first design system
status: accepted
supersedes: []
date: 2026-09-08
---

## Context

The brief asks for a frontend app. The interesting decisions are not which framework — React is the
default and nothing here argues against it — but how features are kept from growing into each other,
and where visual decisions live.

Frontend codebases decay in two specific ways. Features import each other's internals until no
screen can be deleted, and styling drifts because every component is free to invent a colour, a
radius and a spacing step. Both are structural problems with structural fixes.

There is also a rendering-model question. Server-side rendering earns its complexity when SEO or
first-paint on a cold cache is the constraint. Behind a sign-in, it mostly is not.

## Decision

A client-rendered React SPA on Vite, organized as isolated feature slices under a shared kernel,
styled exclusively through design tokens with a small set of vendored primitives.

The rules:

- Three top-level areas: `routes/` (thin — they compose), `features/<slice>/` (one user-facing
  feature each), `shared/` (the app kernel: API client, query keys, error handling, session).
- **A slice never imports another slice.** Shared code moves to `shared/`; that is what it is for.
  `shared/` never imports a slice or a route. Both directions are enforced by dependency-cruiser,
  because a rule this easy to break needs a machine to notice.
- Network access goes through `shared/api` only. A `fetch` elsewhere is a gate failure — it is how
  an untyped, unretried, unauthenticated call gets into a component.
- TanStack Router for type-safe routing, TanStack Query for server state. There is no client state
  container: almost all state here is server state, and treating it as such removes the cache
  invalidation bugs that a store would recreate.
- Styling is tokens (`packages/styles`) and vendored primitives — copied-in source rather than a
  component-library dependency, so a primitive can be changed rather than fought. Radix supplies
  behaviour (focus management, dismissal, ARIA wiring) where behaviour is the hard part.
- Accessibility floors are asserted, not assumed: primitives carry tests for their keyboard and
  labelling behaviour, and the e2e suite has an accessibility pass.

## Consequences

A feature can be deleted by deleting its folder, which is the practical test of whether isolation
holds. Visual consistency comes from the token layer rather than from review vigilance. Server state
has one owner, so cache invalidation is a query-key decision rather than an ad hoc one.

The costs: client rendering means no SEO for content behind the router and a blank first paint until
the bundle lands — acceptable here, and a real limitation if a public product catalogue later needs
indexing. Vendored primitives are code this repository now maintains. And slice isolation
occasionally forces a genuinely shared concern into `shared/` earlier than it feels ready.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Next.js / Remix (SSR) | Earns its complexity for public, indexable, first-paint-critical pages; this app is mostly behind a session. |
| A component library as a dependency (MUI, Chakra) | Faster to start; every deviation from its opinions becomes a fight, and theming is the deviation you always need. |
| Redux or Zustand for server data | Recreates caching, invalidation and request de-duplication that TanStack Query already solves. |
| Tailwind used directly with no token layer | Utility classes with no constraint drift exactly as fast as hand-written CSS does. |
| Feature folders without an enforced isolation rule | The convention everyone agrees with and nobody notices breaking. |
