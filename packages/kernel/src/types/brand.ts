/** Nominal-typing helper for opaque identifiers, e.g. `Brand<string, 'UserId'>`. */
export type Brand<T, B extends string> = T & { readonly __brand: B };
