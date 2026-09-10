// Fixture, three non-violating shapes in one file — none of these is a bare `fetch(` call:
//   1. `prefetchWidgets(` — a longer identifier ending in "fetch(", not the global.
//   2. `apiClient.fetch(` — a property named `.fetch`, not `globalThis.fetch`.
//   3. this prose line, which merely mentions `fetch(` while explaining the two shapes above —
//      comment-only lines are skipped entirely, the same reason
//      `apps/app/src/shared/session/auth-client.ts` stays clean in the real repo.
import { apiClient } from '../../shared/api/index.js';

export function prefetchWidgets(id: string): void {
  apiClient.fetch(id);
}
