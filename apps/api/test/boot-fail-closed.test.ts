/**
 * spec — the fail-closed boot proof (ADR-0005/ADR-0005): the real composition root
 * (`bun src/runtime/main.ts`, spec ) launched in `APP_MODE=production` with an otherwise-empty
 * environment must abort boot with exit code 1 and name EVERY missing required key on stderr —
 * never come up half-configured, never surface config gaps as runtime 500s.
 *
 * Unit-lane (`.test.ts`, no containers): a fail-closed tier's boot fails at config composition
 * (spec step 2) before anything connects to Postgres/Redis/OTLP, so this needs no Docker and
 * runs on every CI pass — a fail-closed guarantee gated behind Docker availability would be no
 * guarantee. It DOES spawn a real `bun` child (the same runtime the suite already uses) to
 * exercise the actual `main().catch` path, not a re-implementation of it.
 *
 * The child env is built from scratch (only PATH/HOME inherited, so the parent shell's own
 * DATABASE_URL etc. can't mask a missing key) and staging/production never load `.env` (spec * step 2 loads it only in `test` mode), so the composed env is exactly `{}`.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MAIN_ENTRY = fileURLToPath(new URL('../src/runtime/main.ts', import.meta.url));
const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Required in every mode (plain Zod requiredness) plus the live-only keys (mode-aware schema,
 * spec ) — with an empty env, live-mode composition must report all of them. */
const EXPECTED_MISSING_KEYS = [
  'DATABASE_URL',
  'REDIS_URL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'DEPLOYMENT_ENVIRONMENT',
  // Auth: fail-closed-required, so live-mode composition must report them too.
  'AUTH_SECRET',
  'AUTH_BASE_URL',
  // security baseline: fail-closed-required (spec — no wildcard-with-credentials
  // default; a live tier must name its allowed origins explicitly).
  'HTTP_CORS_ALLOWED_ORIGINS',
];

// NOT listed above: `HTTP_TRUST_PROXY`, though a fail-closed tier does refuse to boot without it
//. Its check is an object-level `superRefine`, and Zod runs those only
// once the base object parses — with an EMPTY env the missing required keys above fail first, so
// the trust-proxy issue is genuinely not reported in this scenario. It surfaces as soon as the
// others are supplied, which is what `api-slice-trust-proxy.test.ts` pins directly. Listing it
// here would assert behavior the config layer does not have.

interface BootResult {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

function bootProductionWithEmptyEnv(): Promise<BootResult> {
  return new Promise<BootResult>((resolve, reject) => {
    const child = spawn('bun', [MAIN_ENTRY], {
      cwd: APP_ROOT,
      // From scratch: only PATH (to find `bun`) + HOME (bun's runtime dirs). Explicitly NOT the
      // parent env, so a DATABASE_URL/REDIS_URL exported in the dev shell cannot satisfy the schema
      // and hide a regression.
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        APP_MODE: 'production',
      },
    });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error('boot-fail-closed: entry did not exit within 30s (should fail immediately)'),
      );
    }, 30_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stderr, stdout });
    });
  });
}

describe('fail-closed boot (spec , ADR-0005)', () => {
  it('APP_MODE=production with empty env exits 1 and lists every missing required key', async () => {
    const result = await bootProductionWithEmptyEnv();

    expect(result.exitCode, `expected exit 1; stderr was:\n${result.stderr}`).toBe(1);
    for (const key of EXPECTED_MISSING_KEYS) {
      expect(result.stderr, `stderr must name the missing key ${key}`).toContain(key);
    }
    // Fail-closed means it aborts at config, before the server ever listens — no "ready" log.
    expect(result.stdout).not.toContain('api.boot.listen');
  }, 40_000);
});
