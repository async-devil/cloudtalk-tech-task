// Fixture: `shared/api/**`'s own carve-out still needs a matching sanctioned file to sit beside,
// so this violation tree is a plausible app tree rather than a lone offending file. This file
// itself is clean (excluded by the gate); the violation lives in `features/widgets/`.
export function request(path: string): Promise<Response> {
  return globalThis.fetch(new Request(path, { credentials: 'include' }));
}
