import { ValidationError } from '@repo/kernel';

/** ADR-0011: snake_case, lower-case, spelled-out identifiers — the same character class the
 * migration-DDL gate will check DDL against, applied here at contract construction. */
const IDENTIFIER_RE = /^[a-z][a-z0-9_]*$/;

/** PostgreSQL truncates identifiers at 63 bytes, silently (ADR-0011). */
const MAX_IDENTIFIER_BYTES = 63;

/** @throws ValidationError when `value` is not `^[a-z][a-z0-9_]*$`. */
export function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_RE.test(value)) {
    throw new ValidationError(
      `${label} "${value}" must match ^[a-z][a-z0-9_]*$ (ADR-0011 identifier rules)`,
    );
  }
}

/** @throws ValidationError when `value` exceeds PostgreSQL's 63-byte identifier limit. Every
 * caller of this function passes a string built entirely from already-`assertIdentifier`-checked
 * `^[a-z][a-z0-9_]*$` segments plus fixed ASCII literals (`fk_`, `__stage_status__`, ...), so
 * `.length` (UTF-16 code units) IS the byte count — no multi-byte codepoint is reachable here,
 * and no `TextEncoder`/`Buffer` ambient declaration is needed for a check this package can only
 * ever run against pure ASCII. */
export function assertIdentifierByteLength(value: string, label: string): void {
  const bytes = value.length;
  if (bytes > MAX_IDENTIFIER_BYTES) {
    throw new ValidationError(
      `${label} "${value}" is ${bytes} bytes, exceeding PostgreSQL's ${MAX_IDENTIFIER_BYTES}-byte identifier limit (ADR-0011) — it would be silently truncated`,
    );
  }
}

/**
 * Bridges an ADR-0011 DB identifier (`^[a-z][a-z0-9_]*$`, e.g. a schema or pipeline name) into an
 * ADR-0009 job-stage/span segment (`^[a-z0-9-]+$`, `NAME_SEGMENT_RE` in
 * `@repo/observability`'s `assertSegment`): the two naming domains agree on lower-case
 * alphanumerics and disagree only on the word separator. A relay/reconciler/retention worker's
 * own stage name is a synthetic identifier this package invents (never a caller-supplied SQL
 * name, never compared byte-for-byte against anything outside this process), so a lossy `_` -> `-`
 * transliteration is safe here — the two domains never need to round-trip.
 */
export function toSegment(identifier: string): string {
  return identifier.replaceAll('_', '-');
}
