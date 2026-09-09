// Fixture: apps/*/src/runtime/** is the composition root — allowed.
export function boot(logger: { fatal(msg: string): void }): void {
  logger.fatal('boot failed');
}
