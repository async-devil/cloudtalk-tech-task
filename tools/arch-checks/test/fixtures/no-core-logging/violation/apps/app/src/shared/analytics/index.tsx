// Fixture, two properties in one file:
//   1. `.tsx` is scanned at all — a React app cannot log freely through JSX files and stay green.
//   2. the app-file allowlist is PATH-EXACT: `shared/observability/index.ts` is allowed,
//      `shared/analytics/index.tsx` beside it is not.
export function track(name: string): void {
  console.error(`track ${name}`);
}
