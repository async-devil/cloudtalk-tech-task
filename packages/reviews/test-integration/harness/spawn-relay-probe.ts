/**
 * Spawns `relay-worker.probe.ts` (or any script of the same shape) as a genuine `bun` OS process
 * and sends it a real `SIGKILL` the INSTANT its stdout contains `markerSubstring` — the mechanism
 * behind the kill-and-restart durability proof (`outbox-relay-durability.test.ts`). Adapted from
 * `packages/messaging/test-integration/harness/spawn-probe.ts`'s `runProbe` (duplicated rather than
 * imported — this package has as little reason to depend on `messaging`'s test harness as that
 * file's own header gives for the reverse), which waits for a NATURAL exit; this waits for a
 * STDOUT MARKER instead, because the whole point is to kill the process while it is still running,
 * not after it finishes.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import process from 'node:process';

export interface MarkerKillResult {
  /** `true` iff the marker appeared before the timeout (the only path that resolves rather than
   * rejects). */
  readonly sawMarker: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `bun <scriptPath>` with `env` merged over a bare `{ PATH }` (matching `runProbe`'s own
 * isolation — the child's env is NOT the parent's, so a stray `DATABASE_URL` in the dev shell can
 * never masquerade as the one this call intends). Resolves the moment `markerSubstring` appears
 * anywhere in accumulated stdout, having already sent `SIGKILL` and awaited the process's actual
 * `exit` event — so by the time this resolves, the OS process is provably gone and its Postgres
 * connection provably closed, not merely "signal sent".
 */
export function runProbeUntilMarker(
  scriptPath: string,
  env: Record<string, string>,
  markerSubstring: string,
  timeoutMs = 30_000,
): Promise<MarkerKillResult> {
  return new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn('bun', [scriptPath], {
      env: { PATH: process.env.PATH ?? '', ...env },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGKILL');
      reject(
        new Error(
          `runProbeUntilMarker: ${scriptPath} never printed "${markerSubstring}" within ` +
            `${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, timeoutMs);

    function killAndResolveOnExit(): void {
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      child.once('exit', () => {
        resolve({ sawMarker: true, stdout, stderr });
      });
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (!settled && stdout.includes(markerSubstring)) {
        killAndResolveOnExit();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    // No independent 'exit' handler beyond `killAndResolveOnExit`'s own: an exit BEFORE the marker
    // ever appears (the probe crashed) should surface as the timeout's diagnostic, not a false
    // "marker seen" — so absence of a marker is always the timeout path, never a silent resolve.
  });
}

/** Parses the LAST non-empty stdout line as JSON — a probe may print diagnostics before its
 * result/marker line, but the final line is always the frozen payload. Mirrors `spawn-probe.ts`'s
 * `lastJsonLine`. */
export function lastJsonLine(stdout: string): Record<string, unknown> {
  const lines = stdout.split('\n').filter((line) => line.trim() !== '');
  const last = lines.at(-1);
  if (last === undefined) {
    throw new Error('lastJsonLine: probe printed no output');
  }
  return JSON.parse(last) as Record<string, unknown>;
}
