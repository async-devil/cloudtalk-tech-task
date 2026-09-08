---
id: ADR-0008
title: A typed error taxonomy, handled once at boundaries
status: accepted
supersedes: []
date: 2026-09-08
---

## Context

Error handling degenerates in a predictable way. A `catch` logs and rethrows, so one failure appears
four times in the logs at four levels of detail. A handler matches on `error.message` because that
was the only thing available, and a library's wording change breaks it silently. A retry decision is
made by whichever layer happened to catch first, which is rarely the layer that knows whether
retrying is safe.

The root cause is that errors carry no structure, so every consumer invents one.

## Decision

Every error a module raises is an `AppError` carrying a code from a closed taxonomy, and it is
handled exactly once — at a boundary, by code whose job is to translate it into that boundary's
vocabulary.

The rules:

- Codes are a closed set. Adding one is a visible change, not a new string literal.
- Never match on a message or a class name. `isAppError` works across module copies, which a
  cross-realm `instanceof` does not — this is checked by a test that constructs the error from a
  duplicated definition.
- No catch-log-rethrow. A `catch` either handles the error or does not exist. If context needs
  adding, it is added to the error, not to a log line.
- Retryability is a property of the error, decided by a classifier at the point the error is
  created, not guessed by the caller. The classifier reads what the underlying client actually
  reports — for AWS SDK clients that is `$metadata.httpStatusCode`, not `.status`, and getting that
  wrong turns a hard rejection into a retried transient failure.
- The boundaries that handle: the HTTP error mapper (code → status + wire shape), the job runner
  (retry or dead-letter), and the SPA's error boundary (code → message the user reads).

## Consequences

A failure appears once in the logs, with structure. The HTTP status for a domain failure is decided
in one file, so it is consistent without anyone remembering to be consistent. Retry decisions are
made where the knowledge is. The SPA can render a specific message per code without parsing prose.

The cost is that every module must map its third-party failures into the taxonomy at its own edge,
which is real work at each adapter, and the taxonomy is a shared vocabulary that needs occasional
curation to avoid becoming either too coarse to be useful or a per-call-site enum.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Native `Error` subclasses with `instanceof` | Breaks across duplicated module copies — exactly the situation the extraction proof creates — and carries no code for a client to switch on. |
| Result types (`Result<T, E>`) everywhere | Excellent guarantees, and it colours every signature in the codebase; a poor fit for the framework surfaces this system sits on. |
| Error strings with a shared prefix convention | Matching on prose, which breaks when the prose changes and nothing tells you. |
| Handling at every layer | The catch-log-rethrow pattern this decision exists to forbid: four log lines, no more information than one. |
