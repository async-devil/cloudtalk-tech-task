/**
 * Spawns a probe script as a genuine `bun` OS process ('s "Bun-globals constraint" — same
 * ADR-0010 escape hatch `apps/api/test/harness/spawn-app.ts` documents: this suite's own
 * Vitest process is real Node regardless of how the `vitest` CLI was launched, so importing
 * `@repo/messaging`'s bus/rate-limiter/`scheduleRepeatable` directly here would hit
 * `globalThis.Bun` as `undefined`). Each probe script is a standalone entry that does its own work
 * against the given `REDIS_URL` and prints exactly one JSON line to stdout as its result — this
 * harness waits for exit and parses that line.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import process from 'node:process';

export interface ProbeResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `bun <scriptPath>` with `REDIS_URL` set, waits for exit (bounded), and returns the
 * captured output. Parsing the JSON result line is the caller's job (probes vary in shape). */
export function runProbe(
  scriptPath: string,
  redisUrl: string,
  timeoutMs = 30_000,
): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn('bun', [scriptPath], {
      env: { PATH: process.env.PATH ?? '', REDIS_URL: redisUrl },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(`runProbe: ${scriptPath} did not exit within ${timeoutMs}ms\nstderr:\n${stderr}`),
      );
    }, timeoutMs);

    child.once('exit', (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Parses the LAST non-empty stdout line as the probe's JSON result — probes may print
 * diagnostics before it, but the final line is always the frozen result payload. */
export function lastJsonLine(stdout: string): Record<string, unknown> {
  const lines = stdout.split('\n').filter((line) => line.trim() !== '');
  const last = lines.at(-1);
  if (last === undefined) {
    throw new Error('lastJsonLine: probe printed no output');
  }
  return JSON.parse(last) as Record<string, unknown>;
}
