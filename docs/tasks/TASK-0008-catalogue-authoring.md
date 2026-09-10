---
id: TASK-0008
title: Catalogue authoring — product creation and editing behind a capability
status: done
adr: [ADR-0016, ADR-0018]
date: 2026-09-09
---

## Scope

The surface that lets a catalogue manager put a product in the catalogue and correct it afterwards:
the `catalogue_manager` column and its migration, the `products.create` and `products.update`
contract procedures and their implementations, the capability guard at the HTTP boundary, the
`canManageCatalogue` field in the session bootstrap payload, and the `catalogue-authoring` feature
slice with the product form (screen S7) and its entry points on the catalogue and product screens.
Server-side slug derivation and the slug/SKU immutability rule belong here.

Specifications: SPEC-0001 (screen S7, journey J5), SPEC-0002 (`slug`, `sku`, the capability column),
SPEC-0003 (`products.create`, `products.update`, the bootstrap field).

## Out of scope

Product deletion or retirement. A screen for granting the capability — it is set by seed or by hand
(ADR-0018). Bulk import. Product images. Category management: the categories are a seeded vocabulary.

## Acceptance criteria

- [x] `auth.app_user.catalogue_manager` exists as `boolean NOT NULL DEFAULT false`, added by its own
      migration rather than an edit to a merged one.
- [x] `products.create` and `products.update` are declared in the contract before they are
      implemented, and appear in the generated OpenAPI document with their error shapes.
- [x] A request with no session receives 401; a request with a session lacking the capability
      receives 403. Both are asserted against the HTTP layer, not against the guard in isolation.
- [x] Removing the capability check from the router turns a test red.
- [x] A slug omitted on creation is derived from the name server-side; a slug supplied on creation is
      used verbatim after validation.
- [x] A duplicate slug and a duplicate SKU each return `CONFLICT` with `details.field` naming which,
      raised from the unique constraint rather than from a pre-flight read.
- [x] `products.update` rejects `slug` and `sku` with `VALIDATION`; neither is silently ignored, and
      a test asserts the stored row is unchanged after such a request.
- [x] A created product is immediately readable at `/products/{slug}` and appears in the catalogue
      list with no rating and no `computedAt`, with no `product_rating` row written.
- [x] The SPA renders the authoring entry points only when `canManageCatalogue` is true, and the
      product form is operable by keyboard alone with its slug preview announced.
- [x] A Playwright spec covers: sign in as the seeded manager, create a product, see it in the
      catalogue, edit its name, and confirm the address did not change.
- [x] `bun run extract-module reviews` still passes.

## Notes

The capability is enforced in two places for two different reasons, and only one of them is
security: the server refuses the write, and the SPA hides the affordance so a person is not offered
an action they cannot take. If they ever disagree, the server is right.

Slug derivation runs server-side even though the form previews it. A client-side slug is a
suggestion; treating it as the value makes the address depend on which client wrote the row.
