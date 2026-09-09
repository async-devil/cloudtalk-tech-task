// Fixture: observability/src/** implements the logger itself — allowed.
export function emit(logger: { error(msg: string): void }): void {
  logger.error('observability owns this call site');
}
