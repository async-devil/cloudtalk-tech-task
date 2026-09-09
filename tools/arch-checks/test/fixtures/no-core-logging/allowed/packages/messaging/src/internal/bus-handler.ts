// Fixture: the bus boundary contract — allowlisted by glob `packages/messaging/src/internal/bus*.ts`.
export function handleEvent(logger: { fatal(msg: string): void }): void {
  logger.fatal('event handling exploded');
}
