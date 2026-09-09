const SENTINEL_DESCRIPTION = 'unknown error (no description)';
const MAX_CAUSE_DEPTH = 3;

function nonEmptyTrimmed(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * `describeError` — total function, never returns `''` (ADR-0003: a dead-letter row must carry a
 * readable description of why the job died, so the classifier that feeds it can't be handed an
 * empty string). Frozen fallback chain (first non-empty wins):
 *
 * 1. An `Error` with a non-empty trimmed `message` -> the message.
 * 2. An `Error` whose `name` is non-empty AND not the constructor default `'Error'` -> the name.
 * (Deviation from a literal reading of ADR-0008: every `Error` has `name === 'Error'` by
 * default, so taking the default name would make step 3 unreachable and erase cause
 * information — honoring the chain's intent requires skipping the information-free default.)
 * 3. A non-nullish `cause` -> recurse on the cause, depth-capped at {@link MAX_CAUSE_DEPTH} (a
 * cyclic/self-caused error must not hang; at the cap, fall through to the next step).
 * 4. A non-empty trimmed `string` error value -> itself.
 * 5. The sentinel: `'unknown error (no description)'`.
 *
 * Output is a description, not a serialization: no stack traces, no JSON dumps.
 */
export function describeError(error: unknown): string {
  return describeAtDepth(error, 0);
}

function describeAtDepth(error: unknown, depth: number): string {
  if (error instanceof Error) {
    const message = nonEmptyTrimmed(error.message);
    if (message !== undefined) {
      return message;
    }
    if (error.name.length > 0 && error.name !== 'Error') {
      return error.name;
    }
    if (error.cause !== undefined && error.cause !== null && depth < MAX_CAUSE_DEPTH) {
      return describeAtDepth(error.cause, depth + 1);
    }
    return SENTINEL_DESCRIPTION;
  }
  if (typeof error === 'string') {
    const trimmed = nonEmptyTrimmed(error);
    if (trimmed !== undefined) {
      return trimmed;
    }
  }
  return SENTINEL_DESCRIPTION;
}
