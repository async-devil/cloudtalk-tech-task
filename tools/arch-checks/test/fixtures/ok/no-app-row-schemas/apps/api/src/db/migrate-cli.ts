// OK: the migrate CLI's own db/ code needs no zod — it drives the migration runner, never a row
// schema (ADR-0011).
export const migrateCliMarker = true;
