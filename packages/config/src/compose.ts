import { InternalError } from '@repo/kernel';
import { z } from 'zod';
import { ConfigError } from './config-error.js';
import { deepFreeze } from './internal/deep-freeze.js';
import type { AppMode } from './mode.js';
import type { ConfigSlice } from './slice.js';
import type { ConfigSource } from './sources.js';

export { ConfigError };

/** The result of a successful {@link composeConfig} call. */
export interface ComposedConfig<T> {
  /** Deep-frozen, parsed exactly once. */
  readonly config: Readonly<T>;
  /** Key names + winning sources, NEVER values (ADR-0005: boot logs names/sources only). */
  readonly report: ReadonlyArray<{ readonly key: string; readonly source: string }>;
}

/** A source that never provided a value for a key that ended up in the composed config — the
 * slice schema's own `.default(...)` filled it in. Reported as the value's provenance so the
 * boot-time report names every key's origin, defaults included. */
const DEFAULT_SOURCE = 'default';

/**
 * Composes config slices from layered sources into one frozen object (ADR-0005): sources are
 * resolved then merged (later source wins), empty-string values become `undefined`, then a
 * single parse runs against the schema built from `{ [sliceKey]: slice.schema(mode) }`. Failures
 * aggregate every issue across every slice (fail-closed, complete report). Duplicate slice keys
 * throw before any source is even resolved.
 */
export async function composeConfig<T>(options: {
  readonly mode: AppMode;
  readonly slices: ReadonlyArray<ConfigSlice<z.ZodType>>;
  readonly sources: ReadonlyArray<ConfigSource>;
}): Promise<ComposedConfig<T>> {
  assertUniqueSliceKeys(options.slices);

  const { normalizedEnv, winningSource } = await mergeSources(options.sources);

  const shape: Record<string, z.ZodType> = {};
  const parseInput: Record<string, Record<string, string>> = {};
  for (const slice of options.slices) {
    shape[slice.key] = slice.schema(options.mode);
    // Every slice sees the same merged env map; each slice's own object schema picks out (and
    // Zod strips, by default, the rest of) only the field names it declares.
    parseInput[slice.key] = normalizedEnv;
  }

  const result = z.object(shape).safeParse(parseInput);

  if (!result.success) {
    throw new ConfigError(issuesFrom(result.error));
  }

  const report = reportFrom(options.slices, result.data as Record<string, unknown>, winningSource);

  // The composed schema is assembled dynamically from caller-supplied slices; T is the caller's
  // nominal shape for the merged config and cannot be derived structurally at the type level.
  const config = deepFreeze(result.data) as T;

  return { config, report };
}

function assertUniqueSliceKeys(slices: ReadonlyArray<ConfigSlice<z.ZodType>>): void {
  const seen = new Set<string>();
  for (const slice of slices) {
    if (seen.has(slice.key)) {
      throw new InternalError(`composeConfig: duplicate config slice key "${slice.key}"`);
    }
    seen.add(slice.key);
  }
}

async function mergeSources(sources: ReadonlyArray<ConfigSource>): Promise<{
  readonly normalizedEnv: Record<string, string>;
  readonly winningSource: Record<string, string>;
}> {
  const merged: Record<string, string> = {};
  const winningSource: Record<string, string> = {};

  for (const source of sources) {
    const loaded = await source.load();
    for (const [key, value] of Object.entries(loaded)) {
      merged[key] = value;
      winningSource[key] = source.name;
    }
  }

  // empty-string ⇒ undefined: drop the key so a required field reports "missing", not "invalid".
  const normalizedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value !== '') {
      normalizedEnv[key] = value;
    }
  }

  return { normalizedEnv, winningSource };
}

function issuesFrom(
  error: z.ZodError,
): ReadonlyArray<{ readonly key: string; readonly message: string }> {
  return error.issues.map((issue) => {
    // path[0] is always the slice key (every slice's field set is parsed under its own key);
    // path[1], when present, is the env key within that slice that actually failed.
    const envKey = issue.path[1] ?? issue.path[0] ?? '(unknown)';
    return { key: String(envKey), message: issue.message };
  });
}

function reportFrom(
  slices: ReadonlyArray<ConfigSlice<z.ZodType>>,
  parsed: Record<string, unknown>,
  winningSource: Record<string, string>,
): ReadonlyArray<{ readonly key: string; readonly source: string }> {
  const seen = new Set<string>();
  const report: Array<{ key: string; source: string }> = [];

  for (const slice of slices) {
    const parsedSlice = parsed[slice.key];
    if (typeof parsedSlice !== 'object' || parsedSlice === null) {
      continue;
    }
    for (const key of Object.keys(parsedSlice)) {
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      report.push({ key, source: winningSource[key] ?? DEFAULT_SOURCE });
    }
  }

  return report.sort((a, b) => a.key.localeCompare(b.key));
}
