// Fixture: a `shared/` file that lives beside `shared/api` but touches no network at all — proves
// the allowlist is a prefix match on `shared/api/**` specifically, not on `shared/` as a whole.
export function identity<T>(value: T): T {
  return value;
}
