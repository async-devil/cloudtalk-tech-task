// Fixture: the one sanctioned network call site — `shared/api/**` is excluded from this gate
// entirely (mirrors the real `apps/app/src/shared/api/index.ts`'s `fetch:` option), so
// `globalThis.fetch(` here must not be flagged.
export function request(path: string): Promise<Response> {
  return globalThis.fetch(new Request(path, { credentials: 'include' }));
}
