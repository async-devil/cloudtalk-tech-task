---
id: ADR-0015
title: The application specification is a third document kind, machine-checked like the other two
status: proposed
supersedes: []
date: 2026-09-09
---

## Context

This repository recognises two kinds of document, and `CONTRIBUTING.md` keeps them strictly separate
by intent: a decision record argues *why it was built this way*, a task states *what needs doing and
how we know it is done*. Both are validated by `tools/arch-checks/src/docs-index.ts`, which is why
neither has drifted.

Neither kind answers the third question a contributor asks first: **what is this system?** What a
product is, what a review is, which screens exist, what the wire looks like, which table holds what.
Today that knowledge exists only as a residue of the tasks — TASK-0002 names four tables it never
defines, TASK-0003 names six routes it never shapes, TASK-0004 names three screens it never
describes. Each task is correct about its own acceptance criteria and silent about its subject. Two
contributors reading them build two different systems, and neither is contradicted by anything
written down.

The obvious repairs each break a rule that already exists. Putting the specification into records
makes an immutable document carry mutable product detail, and every corrected column name becomes a
superseding ADR. Putting it into tasks makes a data model die when its unit of work closes. Putting
it into a `docs/spec.md` that nothing validates produces exactly the drift the generated index was
built to prevent — and an unchecked document in a repository where every other rule names its check
is a document reviewers learn to distrust.

There is also a question of what a specification *is*, given records already exist. A record decides
between alternatives; a specification states the consequence in enough detail to build from. "The
rating aggregate is a projection" is ADR-0014's decision. "`reviews.product_rating` holds
`review_count`, `rating_average` and `computed_at`, keyed by `product_id`" is not a decision at all —
it is the shape that decision implies, and it belongs where it can be corrected without re-opening
the decision.

## Decision

`docs/spec/` is a third document kind — the specification of what the system is, mutable, referencing
the records that constrain it — validated and indexed by the same generator that validates records
and tasks.

The contract, in the shape the other two already use:

- `docs/spec/SPEC-XXXX-kebab-case-title.md`; ids sequential per folder, zero-padded to four, never
  reused or renumbered.
- Frontmatter: `id`, `title`, `status` (`draft` | `accepted` | `superseded`), `supersedes`, `adr`,
  `date`.
- Body sections, in this order: Context → Specification → Open questions → Traceability. The last is
  the load-bearing one: it maps each part of the specification to the records that constrain it and
  the tasks that implement it, so a reader arriving from any of the three folders can reach the other
  two.
- A specification is mutable. `draft` → `accepted`, and `accepted` → `superseded` only when a newer
  specification names it in `supersedes`. Correcting a specification is normal work; changing a
  decision is not, and that asymmetry is the reason the two kinds are separate.
- `docs-index.ts` enforces all of it, and `docs/README.md` grows a third table.

## Consequences

A contributor reads one folder to learn what to build, and the reading order in `CLAUDE.md` gains a
step between the task and its records. Acceptance criteria stop carrying design by implication: a
task can say "the aggregate is rebuildable" because a specification says what the aggregate is.
Because specifications are machine-checked, a spec that names a record which does not exist, or that
drops a section, fails `docs-check` rather than being noticed in review or not at all.

The costs, stated plainly. Three kinds is one more boundary to police, and the "is this in the right
folder" judgement gets harder, not easier — the heuristic warning in `docs-index.ts` covers records
and tasks and cannot be extended to prose this open-ended. A mutable checked-in specification can be
edited without a superseding document, so its history lives in git rather than in the folder, which
is weaker provenance than a record has and is the price of not paying ADR ceremony for a renamed
column. And the generator now validates three schemas, so the file that must never be wrong grew.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| A single unvalidated `docs/spec.md` | Cheapest, and outside the generated index: nothing notices when it stops describing the system. In a repository where every rule names its check, an unchecked document is one reviewers stop trusting. |
| Fold the specification into ADRs | Makes immutable records carry mutable detail; every corrected column name becomes a superseding record, and the folder stops being a set of decisions. |
| Fold the specification into tasks | A data model outlives the unit of work that introduced it. When the task closes, the specification becomes historical, and the next task restates it differently. |
| Keep it in the tasks implicitly, as today | The status quo: the subject of every acceptance criterion is inferred. It is what this record exists to end. |
| An external tool (Notion, Confluence) | CI cannot read it, review cannot diff it, and it is not in the clone the brief asks to be delivered. |
| Generate the specification from code | Reverses the order — the specification is what the code is judged against, and a document derived from the implementation can never disagree with it. |
