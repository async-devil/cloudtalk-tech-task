---
id: TASK-0001
title: Workspace scaffold, foundation modules, and the gate chain
status: in-progress
adr: [ADR-0001, ADR-0002, ADR-0003, ADR-0004, ADR-0005, ADR-0006, ADR-0007, ADR-0008, ADR-0009, ADR-0010, ADR-0011, ADR-0012, ADR-0013]
date: 2026-09-08
---

## Scope

Stand up the workspace this system is built in: the Bun/moon toolchain, the strict TypeScript and
Biome configuration, the ten foundation packages (`kernel`, `entities`, `config`, `observability`,
`contracts`, `persistence`, `messaging`, `jobs`, `auth`, `styles`), the two applications
(`apps/api`, `apps/app`) with an HTTP edge, health probes, a composition root and a sign-in flow,
the architecture gate suite and the module extraction proof under `tools/`, the local Docker Compose
stack, and the decision records and task index under `docs/`.

## Out of scope

The review domain itself — its schema, its contract, its routes and its screens. `apps/api` serves
health and authentication and nothing else at the end of this task; `apps/app` renders a shell and a
sign-in flow. Deployment beyond local Compose. Any production mail transport (ADR-0013 records why).

## Acceptance criteria

- [ ] `bun install` succeeds on a clean checkout with no network access beyond the registry.
- [ ] `moon ci` exits zero and its trailing task count reports every project's `lint`, `typecheck`,
      `build` and `test` as run, not cached.
- [ ] `docker compose -f deploy/compose/dev.yml up -d` brings up Postgres and Redis, and
      `moon run api:migrate` applies every migration against a fresh database.
- [ ] `GET /health` and `GET /health/worker` return 200 with the api running in `test` mode and no
      secrets configured.
- [ ] A magic-link sign-in completes end to end against the development mail adapter.
- [ ] `bun run extract-module --matrix` reports pass for every package; `styles` reports
      `pass (build-only)`.
- [ ] `moon run root:arch-checks-selftest` passes, and every gate's red fixture is red when its
      checker runs against it.
- [ ] `bun run docs-index` is clean, and running it with `--write` twice produces no diff.
- [ ] `grep -rIn -E 'WI-[0-9]|T-[0-9]{3}|AUD-[0-9]|CP-[ABC]|docs/designs'` over the tree returns
      nothing.
- [ ] Every module has a README naming its purpose, public contract, dependencies, config slice,
      named invariants with test ids, and telemetry.

## Notes

The extraction proof is the load-bearing acceptance criterion. A module that does not lift is a
module whose dependencies are not what its manifest claims, and the manifest is what every other
guarantee in ADR-0001 rests on.
