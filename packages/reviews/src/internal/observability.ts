import { createModuleObservability } from '@repo/observability';

/**
 * This module's observability facade (ADR-0009) — the ONE `createModuleObservability` call this
 * package makes. Every span this module opens is named `reviews.{object}.{verb}` through it; no
 * counter or histogram is created here (SPEC-0004 assigns this module's only instruments to
 * TASK-0005's outbox relay — see the README's Telemetry section).
 *
 * One kind of declaration: the module-scoped facade instance every other file in this package
 * imports, never constructed twice.
 */
export const obs = createModuleObservability('reviews');
