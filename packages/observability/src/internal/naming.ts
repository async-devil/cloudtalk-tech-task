import { ValidationError } from '@repo/kernel';

/**
 * ADR-0009 name shape for module-owned spans and instruments: `{module}.{object}.{verb}`,
 * lowercase, dot-separated, no ids in names (ids are span attributes).
 */
export const NAME_SEGMENT_RE = /^[a-z0-9-]+$/;
export const SPAN_NAME_RE = /^[a-z0-9-]+(\.[a-z0-9-]+){2}$/;
/** A bus event type: two-or-more lowercase dot-separated segments (`{domain}.{verb}`, ADR-0007
 * naming rule) — distinct from {@link SPAN_NAME_RE}'s fixed three-segment module-owned shape. */
export const EVENT_TYPE_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function assertSegment(value: string, what: string): void {
  if (!NAME_SEGMENT_RE.test(value)) {
    throw new ValidationError(
      `${what} "${value}" must be lowercase [a-z0-9-] (ADR-0009 naming rules)`,
    );
  }
}

/** Validates a bus event type value: lowercase, dot-separated, at least two segments
 * (`{domain}.{verb}`, ADR-0007). */
export function assertEventType(value: string, what: string): void {
  if (!EVENT_TYPE_RE.test(value)) {
    throw new ValidationError(
      `${what} "${value}" must be lowercase dot-separated segments, e.g. "note.processed" (ADR-0007)`,
    );
  }
}

/**
 * Validates a facade span/instrument name: full `{module}.{object}.{verb}` shape AND the first
 * segment must equal the owning module (ADR-0009: module-owned names are queryable by
 * convention; a name claiming another module's namespace is a review-escaping lie).
 */
export function assertModuleName(moduleName: string, name: string, what: string): void {
  if (!SPAN_NAME_RE.test(name)) {
    throw new ValidationError(
      `${what} "${name}" must match "{module}.{object}.{verb}" (lowercase, dot-separated, no ids)`,
    );
  }
  const firstSegment = name.slice(0, name.indexOf('.'));
  if (firstSegment !== moduleName) {
    throw new ValidationError(
      `${what} "${name}" must start with its owning module "${moduleName}" (got "${firstSegment}")`,
    );
  }
}
