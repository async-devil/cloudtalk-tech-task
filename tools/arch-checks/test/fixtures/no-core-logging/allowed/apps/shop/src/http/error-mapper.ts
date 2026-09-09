// Fixture: apps/*/src/http/** is a boundary subtree — allowed.
export function mapError(logger: { error(msg: string): void }): void {
  logger.error('request failed');
}
