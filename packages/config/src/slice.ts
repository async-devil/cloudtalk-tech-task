import type { z } from 'zod';
import type { AppMode } from './mode.js';

/**
 * A module's config slice (ADR-0005): a unique `key` plus a mode-aware Zod schema factory
 * (`live` mode is typically stricter — conditional requirements via `superRefine`).
 */
export interface ConfigSlice<S extends z.ZodType> {
  readonly key: string;
  readonly schema: (mode: AppMode) => S;
}

/** Defines a {@link ConfigSlice}. A thin identity function — its value is the frozen shape it
 * enforces at the type level, so every module declares slices the same way. */
export function defineConfigSlice<S extends z.ZodType>(
  key: string,
  schema: (mode: AppMode) => S,
): ConfigSlice<S> {
  return { key, schema };
}
