// Fixture: the job boundary — allowlisted by exact file path.
export function runJob(logger: { error(msg: string): void }): void {
  logger.error('job failed terminally');
}
