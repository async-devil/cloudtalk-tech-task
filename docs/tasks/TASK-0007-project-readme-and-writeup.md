---
id: TASK-0007
title: Project README and the architecture write-up
status: done
adr: []
date: 2026-09-08
---

## Scope

The root `README.md` a reviewer reads first: what the system is, how to run it, how it is put
together, where the decisions are recorded, and what was deliberately left out. Plus `ARCHITECTURE.md`
as the narrative walk through the module map and the three lifecycles (a request, a job, an event).

## Out of scope

Re-arguing decisions. The README links to the records; it does not restate them.

## Acceptance criteria

- [x] The setup command appears above the fold and works exactly as written.
- [x] Every architectural claim in the README names the check that enforces it or the record that
      decides it.
- [x] The known limitations are listed explicitly, including the absent mail transport and the
      eventual consistency of the rating aggregate.
- [x] `ARCHITECTURE.md` traces one review submission from the HTTP request to the recomputed
      projection, naming each module it passes through.
- [x] Every internal link resolves; the docs check is green.
- [x] A reader who knows TypeScript but not this repository can locate where a new bounded context
      would go, from the README alone.

## Notes

The brief asks for documentation of the thought process and the trade-offs. That is what `docs/adr/`
is; the README's job is to make a reviewer want to open it, and to be honest about what is missing.
