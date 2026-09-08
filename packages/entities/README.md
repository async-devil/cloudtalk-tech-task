# @repo/entities

The declared vocabulary of this system's stored data: the closed value sets that exist as
reference-table rows, and the public-token registry every table's `token` column is minted from.
It declares shapes and constants — it holds no behaviour, no queries and no wire types.

**When NOT to use this.** If you are reaching for it to share a type between two modules that talk
over HTTP, you want `@repo/contracts` instead: the wire shape and the storage shape are different
things and are allowed to drift. If you are reaching for it to park a constant that has no
reference table and no token behind it, you want the module that owns the concept — this is not a
constants bag.

## Public contract

| Export | What it is |
|---|---|
| `TOKEN_PREFIX`, `TokenPrefix` | The prefix registry — `Product` (`prd`), `Review` (`rev`), `User` (`usr`) |
| `TOKEN_ALPHABET`, `TOKEN_RANDOM_LENGTH` | The 62-symbol alphabet and 21-character length every token's random segment uses |
| `mintToken(prefix)` | The only sanctioned way to produce a `token` column value anywhere |
| `STAGE_STATUS` + its id/name/row types and `stageStatusRowSchema` | A pipeline stage's lifecycle states |
| `BRANCH_KIND`, `BRANCH_STATUS` + their types and row schemas | The fan-out branch vocabulary |
| `OUTBOX_ROW_STATUS` + its types and row schema | The outbox row lifecycle |

Each vocabulary ships three things together: the `const` object naming the values, the row schema
that parses the reference table, and the derived id/name types. They are one unit because a value
set that exists in code but not in the table — or the reverse — is the drift this module exists to
prevent.

## Dependencies

| Dependency | Why |
|---|---|
| `zod` | The row schemas. A reference table is read at a boundary like anything else (ADR-0002). |
| `nanoid` | `customAlphabet` for the token random segment. Never called bare — see below. |

No workspace dependencies. This module sits at the facade tier and imports nothing from the
repository, which is what lets every other module depend on it.

## Config slice

None. This module reads no configuration.

## Named invariants

- **INV-1:** `TOKEN_ALPHABET` contains no `_` and no `-`, because those collide with the token's own
  prefix separator and break in URLs and CSV exports
  (→ `test/token.test.ts::is the explicit 62-symbol alphanumeric alphabet — no underscore, no hyphen`).
- **INV-2:** `mintToken` produces `{prefix}_{21 characters}` drawn only from `TOKEN_ALPHABET`
  (→ `test/token.test.ts::mints \`{prefix}_{21-char random}\` over TOKEN_ALPHABET only`).
- **INV-3:** every call mints a fresh random segment
  (→ `test/token.test.ts::mints a fresh random segment on every call (collision-free at test volume)`).
- **INV-4:** the prefix registry is exactly `{ Product, Review, User }` — an addition or a removal is
  a reviewed change, because stored tokens carry these prefixes forever
  (→ `test/token.test.ts::holds exactly the prefixes this system mints`).
- **INV-5:** prefixes are distinct, so a token names exactly one kind of thing
  (→ `test/token.test.ts::gives every prefix a distinct value, so a token names one kind of thing`).
- **INV-6:** every stage, branch and outbox vocabulary's ids and names agree with its row schema
  (→ `test/jobs-vocabulary.test.ts`).

## Telemetry

None. This module emits no spans and declares no instruments — it has no behaviour to observe.

## Extraction

```
bun run extract-module entities
```

No module-specific notes: it has no workspace dependencies, so its extraction closure is itself.
