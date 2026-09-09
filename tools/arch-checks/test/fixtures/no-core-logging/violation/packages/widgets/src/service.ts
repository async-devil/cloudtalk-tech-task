// Fixture: a package core module logging a failure directly instead of propagating to a
// boundary (ADR-0009) — must be flagged.
export function doWidgetThing(logger: { error(obj: object, msg: string): void }): void {
  try {
    riskyThing();
  } catch (error) {
    logger.error({ err: error }, 'widgets: failed');
    throw error;
  }
}

function riskyThing(): void {
  throw new Error('boom');
}
