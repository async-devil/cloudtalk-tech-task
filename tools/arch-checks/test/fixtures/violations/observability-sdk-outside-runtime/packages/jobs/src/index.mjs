// Deliberate violation: the @repo/observability/sdk entry (OTel SDK wiring) imported from a
// product module -- ADR-0009 restricts it to apps/*/src/runtime/** composition roots.
import { initObservability } from '@repo/observability/sdk';

export { initObservability };
