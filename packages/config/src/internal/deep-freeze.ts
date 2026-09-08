/** Recursively freezes an object graph — the composed config is "deep-frozen, parsed exactly
 * once" (ADR-0005). Safe to call on already-frozen or primitive values. */
export function deepFreeze<T>(value: T): T {
  if (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    !Object.isFrozen(value)
  ) {
    Object.freeze(value);
    for (const propertyName of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[propertyName]);
    }
  }
  return value;
}
