import { ConfigError } from './config-error.js';

/** The one mode switch (ADR-0005): a deployment tier. `test` uses
 * deterministic stubs and lenient config (automated tests + provider-free local dev); `staging`
 * and `production` use real adapters and fail-closed config.
 *
 * Declared once as a const-object value set (ADR-0003): the `AppMode` union and the
 * `APP_MODES` list are both derived, so no call site re-lists the tiers or scatters raw literals. */
export const APP_MODE = {
  Test: 'test',
  Staging: 'staging',
  Production: 'production',
} as const;
export type AppMode = (typeof APP_MODE)[keyof typeof APP_MODE];
export const APP_MODES = Object.values(APP_MODE) as readonly AppMode[];

function isAppMode(value: string): value is AppMode {
  return (APP_MODES as readonly string[]).includes(value);
}

/**
 * Reads `APP_MODE` from the given env map. Accepts only the three tiers; missing or unrecognized
 * values throw {@link ConfigError} — no default, no inference from `NODE_ENV` (ADR-0005).
 */
export function readAppMode(env: Record<string, string | undefined>): AppMode {
  const raw = env.APP_MODE;
  if (raw !== undefined && isAppMode(raw)) {
    return raw;
  }
  const message =
    raw === undefined
      ? 'APP_MODE is required and must be one of: test, staging, production'
      : `APP_MODE has invalid value "${raw}" — must be one of: test, staging, production`;
  throw new ConfigError([{ key: 'APP_MODE', message }]);
}

/**
 * The single distinguishing predicate (ADR-0005): `staging`/`production` run fail-closed with real
 * adapters; `test` is lenient with deterministic stubs. Config slices and the SDK key their
 * strictness off this so no call site re-derives the mode split.
 */
export function isFailClosed(mode: AppMode): boolean {
  return mode !== APP_MODE.Test;
}
