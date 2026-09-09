import { createModuleObservability } from '@repo/observability';

/**
 * This module's observability facade (ADR-0009) — the ONE `createModuleObservability` call this
 * package makes. Every span this module opens is named `reviews.{object}.{verb}` through it; no
 * counter or histogram is created in THIS file — `rating.ts` builds this package's two instruments
 * (`RATING_RECOMPUTE_INSTRUMENT`, `RATING_LAG_INSTRUMENT`, TASK-0005/SPEC-0004) off this same `obs`
 * instance, colocated with the one function that emits them rather than declared here — see the
 * README's Telemetry section.
 *
 * One kind of declaration: the module-scoped facade instance every other file in this package
 * imports, never constructed twice.
 */
export const obs = createModuleObservability('reviews');
