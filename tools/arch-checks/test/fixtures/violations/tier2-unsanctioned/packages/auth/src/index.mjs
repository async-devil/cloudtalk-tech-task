// Deliberate violation: unsanctioned Tier-2 -> Tier-2 edge (ADR-0001). `auth -> styles` has no row
// in SANCTIONED_TIER2_EDGES (tools/arch-checks/src/module-registry.cjs) — unlike `auth ->
// persistence`, which IS sanctioned there for auth's own hand-written SQL.
export { classNames } from '../../styles/src/index.mjs';
