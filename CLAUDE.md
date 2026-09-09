# CLAUDE.md

Agent entry point. **This file is a pointer, not a source of truth**: the records in
[`docs/adr/`](docs/README.md) are the law, and each one names the machine check that enforces it.
If anything here disagrees with a record or with CI, the record and CI win — fix this file.

## What this is

A product-review system built as a modular monolith: Bun + Elysia + oRPC + Kysely + BullMQ +
Postgres with full OpenTelemetry, plus a React SPA. Start with [README.md](README.md), then
[docs/README.md](docs/README.md).

## Before writing code

1. Read [docs/README.md](docs/README.md) and find the task with `status: ready`.
2. Read that task file in full.
3. Read the specifications in [`docs/spec/`](docs/spec/) that cover what it builds — they say what
   the thing IS; the task only says when it is done (ADR-0015).
4. Read every record named in its `adr:` field, in full.
5. Only then write code.

## The laws you will actually touch

1. **Modules are bounded contexts.** Cross-module means a typed port in `@repo/contracts` or an
   event on messaging — never another module's internals (ADR-0001). dependency-cruiser enforces
   it; do not argue with it.
2. **Every module must survive extraction** — `bun run extract-module <name>` is the proof
   (ADR-0001). If your change breaks it, your change is wrong.
3. **Concrete adapters exist only in `apps/*/src/runtime/`**, every port has a deterministic stub,
   and `APP_MODE ∈ test | staging | production` is the only mode switch (ADR-0005): `test` means
   stubs and lenient config, the others mean real adapters and fail-closed boot.
4. **Postgres is the truth; projections are rebuildable; the outbox is for real cross-process
   fan-out only** (ADR-0006, ADR-0007).
5. **Workers follow the six-step shape** — state check, advisory-lock claim, external call outside
   the transaction, write-ahead, single commit (ADR-0007). Never enqueue without a deterministic
   job id; never call a provider inside a transaction.
6. **Errors are typed and handled once, at a boundary** (ADR-0008). No catch-log-rethrow, no
   matching on names or messages.
7. **Observability through the facade only**: `withSpan` named `{module}.{object}.{verb}`, no ids
   in metric attributes, logs only through the facade logger (ADR-0009).
8. **Migrations are hand-written, descriptively named, append-only, and immutable once merged**
   (ADR-0006).
9. **Parse at boundaries with Zod; trust types inside** (ADR-0004). Raw SQL rows go through
   `rowAs`/`rowsAs`.
10. **Decision records are immutable.** To change one, write a superseding record that names it
    (see the documentation contract in [CONTRIBUTING.md](CONTRIBUTING.md)).

## Do not

- Add a dependency without a reason recorded where it is introduced.
- Weaken a tsconfig flag, or add `any` or `@ts-ignore` without a written constraint at the site
  (ADR-0003).
- Create a `utils/`, `helpers/` or `misc/` folder. A name that does not say what is inside will
  accept anything.
- Comment out or skip a CI gate — `gate-integrity` fails the build, and a hollow gate is worse than
  no gate.
- Read `process.env` outside `@repo/config`, log a secret, or put one in a URL.

## Commands

```
bun install
bun moon ci                      # the full local gate chain
bun moon run <project>:test      # or :build, :dev, :typecheck
bun run extract-module <name>    # the module autonomy proof (--all for every module)
bun run docs-index -- --write    # regenerate docs/README.md after touching a record
```

Two things about running the chain locally. `moon` is not on PATH — use `./node_modules/.bin/moon`;
a bare `moon ci` exits 0 having run nothing, which reads as a false green. And read the trailing
`Tasks: N completed` line and its cache counts: a fully cached run proves the last run was green,
not this one.

## Testing standard

A green suite proves tests ran, never that they asserted the right thing. Before accepting a test
that covers a security or durability property, mutate the behaviour it claims to check, watch the
test go red, and restore it. Review test bodies, not test names (ADR-0010).
