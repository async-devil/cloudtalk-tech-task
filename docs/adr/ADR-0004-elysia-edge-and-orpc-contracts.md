---
id: ADR-0004
title: An Elysia HTTP edge over contract-first oRPC, parsing at boundaries with Zod
status: accepted
supersedes: []
date: 2026-09-08
---

## Context

The system has two consumers of its API: a React SPA in this repository, and whatever comes next.
The first wants end-to-end types without a code-generation step in the middle; the second wants an
OpenAPI document. A design that serves only the first ties the API to one client, and a design that
serves only the second throws away the type safety of having both halves in one workspace.

Separately: data arriving from the network is untrusted, and the moment where that stops being true
must be a single identifiable line. A codebase that validates opportunistically ends up validating
the same field three times in three shapes and missing it in a fourth.

## Decision

Define the API as an oRPC contract in `@repo/contracts` — the single artifact the server implements
and the client consumes — serve it through an Elysia edge that owns transport concerns, and parse
every inbound payload with Zod at that boundary so everything inside the process can trust its
types.

What follows from it:

- The contract is implemented through `implement(appContract).router(...)`, so a namespace added to
  the contract and not implemented is a compile error rather than a 404 found in production.
- The same contract produces the OpenAPI document, so the document cannot drift from the handlers.
- Elysia owns what is genuinely transport: security headers, CORS, the body cap, rate limiting, and
  the error mapping from the typed taxonomy (ADR-0008) to status codes.
- Raw SQL rows are parsed through the same discipline (`rowAs`/`rowsAs`) before entering the domain
  — a database is a boundary too.
- Route templates, never concrete paths, are what reach metric attributes; per-entity ids in a
  label set explode the series count (ADR-0009).

One mechanical fact worth recording, because it is not obvious and has produced real defects:
Elysia's lifecycle hooks do not fire for `.mount()`-ed handlers. The oRPC handler is mounted, so
anything expressed as a hook — session resolution, response headers — does not reach contract
routes and has to be applied inside the mounted handler or in an explicit wrapper.

## Consequences

The client gets inferred types with no generation step and no drift, and third parties get an
OpenAPI document generated from the same source. Validation has one place, so "where does untrusted
become trusted?" has a one-line answer. Adding a route means editing the contract, which is exactly
the review surface a public API should have.

The costs: oRPC is a smaller ecosystem than tRPC or a hand-written REST layer, and the contract is a
real indirection — a one-field change touches the contract, the router and the client. The mounted
handler's hook behaviour is a trap for anyone who assumes framework middleware applies uniformly,
which is why it is written down here rather than rediscovered.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Hand-written REST with OpenAPI generated from code | The document drifts from the handlers, because nothing forces them to agree. |
| tRPC | Excellent inference, no first-class OpenAPI, and this API should be callable by something that is not this SPA. |
| GraphQL | Solves a client-shaping problem this product does not have, and brings resolver-level N+1 and caching questions with it. |
| Validation inside each handler, ad hoc | The same field ends up validated three ways and missed a fourth time. |
| Elysia's own schema layer instead of Zod | Ties the validation vocabulary to the HTTP framework; Zod schemas are reused by the contract, the workers and the row parsers, none of which are HTTP. |
