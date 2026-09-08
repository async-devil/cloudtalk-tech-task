---
id: ADR-0010
title: Vitest, container-backed integration proofs, and mutation as the acceptance standard
status: accepted
supersedes: []
date: 2026-09-08
---

## Context

A green test suite proves that tests ran. It does not prove they asserted the right thing, and the
gap between those two facts is where most defects that survive review live. Concretely, the failure
shapes that recur: a fixture shaped to agree with the implementation it tests (an adapter that reads
a header case-sensitively, tested only against fixtures that spell it the same way); an assertion
that cannot fail (checking for a tag the server renders whether or not the code under test ran); a
security comparison where replacing the constant-time compare with `===` leaves all thirty tests
green.

Separately: durability claims cannot be tested with mocks. "A crash between the call and the write
is recoverable" is a statement about a real database and a real queue.

## Decision

Vitest is the runner; unit tests run against stubs and integration tests run against real Postgres
and Redis in Testcontainers; and a test covering a security or durability property is accepted only
after mutation — break the behaviour, watch the test go red, restore it.

Supporting rules:

- Every port has a deterministic stub (ADR-0005), which is what makes unit tests fast and honest.
- Container suites are serialized behind a shared mutex. Several simultaneous container stacks make
  wall-clock assertions flake on a contended host, and a flake in a durability proof is
  indistinguishable from the defect it exists to catch.
- Named invariants live in each module's README with the test id that proves them, checked both
  ways: an invariant with no test, and a test tagged with an invariant its README does not list,
  both fail.
- Read test *bodies* in review, not test names. A test named for a property it does not assert is
  worse than no test, because it stops anyone from writing the real one.
- Assertions about timing are stated as ratios against a yardstick measured in the same run, never
  as an absolute copied from a constant in the source.
- Check the trailing task count and the cache counts when reading a green chain. A fully cached run
  proves the last run was green, not this one.

## Consequences

Durability and security properties are proven against real infrastructure, and the proof is
re-runnable. Mutation makes "this test passes" mean something. The invariant map keeps module
documentation honest by making it a build input.

The costs: container suites are slow and need Docker, so a contributor without it runs a subset. The
mutex trades wall-clock time for reliability. Mutation is manual discipline — no tooling enforces
it — and it is therefore the practice most likely to erode, which is why it is written down as a
standard rather than left as a habit.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| `bun test` | One less dependency, and a thinner assertion and mocking surface than the container-backed suites need. |
| Mocked database and queue throughout | Fast, and structurally unable to prove any statement about crash recovery — which is the main thing worth proving here. |
| A shared long-lived test database | Cross-test contamination and an ordering dependency that surfaces as a flake months later. |
| Coverage percentage as the quality gate | Measures lines executed, not properties asserted — the exact confusion this strategy is built to avoid. |
| Automated mutation testing (Stryker) | The right idea mechanized; too slow to run per-PR at this size. Applied by hand where it matters instead. |
