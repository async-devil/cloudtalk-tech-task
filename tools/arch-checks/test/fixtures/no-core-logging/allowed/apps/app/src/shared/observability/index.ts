// Fixture: the SPA's error-reporting boundary — the one app file named in ALLOWED_APP_FILES.
// Proves the allowlist mechanism, not silence, is what keeps this clean.
export function reportError(error: Error): void {
  console.error(error);
}
