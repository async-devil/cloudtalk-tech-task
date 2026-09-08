---
id: ADR-0009
title: OpenTelemetry behind a facade, with span naming and cardinality rules
status: accepted
supersedes: []
date: 2026-09-08
---

## Context

Instrumentation added ad hoc produces signals that do not correlate: a span named one way here and
another way there, a metric whose label set includes a user id and therefore has a million series,
and log lines that cannot be joined to the trace that produced them. Each of these is individually
minor and collectively the difference between telemetry you can debug with and telemetry you pay
for.

Cardinality in particular is a cost problem that presents as a bill, months after the commit.

## Decision

All instrumentation goes through the `@repo/observability` facade — `withSpan`, the instrument
factories, and the logger — with span names shaped `{module}.{object}.{verb}`, ids allowed on spans
and forbidden in metric attributes, and every instrument declaring the attributes it permits.

Specifically:

- `withSpan` is the only way a module opens a span, and every call site carries a comment saying
  what the span covers. Names are literals so they can be enumerated by a check.
- Instruments are declared with an allowed-attribute list, and that list is re-checked on every
  record. A high-cardinality label is rejected at the call, not discovered on an invoice.
- Ids belong on spans — that is what a trace is for — and never on a metric.
- Logs go through the facade logger only, so every record carries trace context and can be joined to
  its span. `console` outside a designated boundary file is a gate failure.
- The SDK entry point is importable only from a composition root; modules use the facade. Nothing in
  a library decides what the process exports to.
- The exemplar path is live rather than seamed: the collector derives request metrics from the
  application's own spans, so a spike in a latency histogram links to the traces that caused it.
- Every module's README lists the spans and instruments it emits, and a check compares that list
  against what the code actually emits, in both directions.

## Consequences

Signals correlate: a slow request is one click from its trace, and its logs are already joined.
Metric cost is bounded by construction. Swapping the exporter or the backend is a composition-root
change, because no module knows what the backend is.

The costs: a facade is indirection, and it means the OpenTelemetry documentation is not directly
applicable — contributors read this repository's facade instead. The attribute allow-lists are
maintenance. And the README-to-code telemetry check is a gate that will occasionally be the reason a
PR is red for a documentation reason, which is the intended trade.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Import `@opentelemetry/api` directly in each module | No naming discipline, no cardinality control, and every module pinned to the SDK's surface. |
| Auto-instrumentation only | Gives HTTP and database spans for free and knows nothing about the domain — no span for "the moderation stage ran". |
| A vendor SDK (Datadog, Sentry) as the primary path | Ties the code to a vendor; OTel behind a facade keeps the exporter a deployment decision. |
| Logs only, no traces or metrics | Cheapest to write; cannot answer "which of these forty steps was slow". |
