---
id: TASK-0006
title: Seed data and a one-command local setup
status: done
adr: [ADR-0005]
date: 2026-09-08
---

## Scope

A seed command that populates a realistic catalogue — products across several categories, review
authors, and reviews with a spread of ratings and dates — plus whatever it takes to reduce a fresh
clone to a single documented command that ends with a working application.

## Out of scope

Production data loading. Fixture generation for tests, which each suite owns.

## Acceptance criteria

- [x] `bun run setup` on a clean checkout brings up containers, applies migrations, seeds, and
      reports the URL to open.
- [x] The command is idempotent: running it twice does not duplicate seed rows — products are
      matched by slug.
- [x] Seeded products carry a readable slug and a valid SKU, and exactly one seeded account holds
      `catalogue_manager`, so both the authoring surface and its 403 are reachable after setup.
- [x] At least one seeded account holds `moderator`, and at least one seeded review is left
      `rejected`, so the moderation screen's filter and its `rejected` view are both exercisable
      immediately after setup.
- [x] Seeded data exercises the projection — at least one product has enough reviews that the
      aggregate is not trivially equal to a single rating.
- [x] Seeded ratings are not uniformly distributed; the product list's sort is visibly meaningful.
- [x] The README's setup section is the command and nothing else, and a reviewer following it on a
      machine with only Docker and Bun succeeds.
- [x] Sign-in works after setup with no secrets configured, in `test` mode.

## Notes

This is the task the brief's "easy to setup" criterion is graded on. The measure is a reviewer with
a clean machine and fifteen minutes, not a developer who already knows the repository.
