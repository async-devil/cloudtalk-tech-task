/**
 * The single error type config-parsing failures surface as. Deliberately extends `Error`
 * directly, not `@repo/kernel`'s `AppError` — it exists to abort boot with a printed report
 * ("print every issue to stderr, exit 1"), before any HTTP/job boundary or the observability
 * facade exists to hand it to.
 */
export class ConfigError extends Error {
  readonly issues: ReadonlyArray<{ readonly key: string; readonly message: string }>;

  constructor(
    issues: ReadonlyArray<{ readonly key: string; readonly message: string }>,
    message = 'Configuration validation failed',
  ) {
    super(message);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}
