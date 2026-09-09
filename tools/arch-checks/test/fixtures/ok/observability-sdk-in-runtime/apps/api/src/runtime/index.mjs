// Clean: the composition root is exactly where @repo/observability/sdk may be imported
// (ADR-0009: SDK wired once, first thing in the runtime root).
import { initObservability } from '@repo/observability/sdk';

export { initObservability };
