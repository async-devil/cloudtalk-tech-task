import process from 'node:process';
import { NotFoundError } from '@repo/kernel';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runJobStage } from '../src/worker.js';

/** Destination-seam capture (same technique observability's own `logger.test.ts` uses via its
 * `setProcessLogger`/`destination` seam — unavailable here across the package boundary, ADR-0001,
 * so this test intercepts the facade's default `process.stdout` destination instead). */
function captureStdout(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // biome-ignore lint/suspicious/noExplicitAny: matching Node's overloaded `write` signature
  (process.stdout as any).write = (chunk: any, ...rest: any[]) => {
    lines.push(String(chunk));
    return original(chunk, ...rest);
  };
  return {
    lines,
    restore(): void {
      process.stdout.write = original;
    },
  };
}

function jsonLines(lines: readonly string[]): Array<Record<string, unknown>> {
  return lines
    .flatMap((chunk) => chunk.split('\n'))
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .filter((parsed): parsed is Record<string, unknown> => parsed !== undefined);
}

const schema = z.object({ noteId: z.string() });
const stage = `worker-test-${crypto.randomUUID()}`;

describe('runJobStage: the job boundary', () => {
  it('success: the handler resolves, `messaging.job.execute` records with no throw, and nothing logs', async () => {
    const capture = captureStdout();
    try {
      await expect(
        runJobStage(
          { stage, pipeline: 'test', schema, handler: async () => undefined },
          { data: { noteId: 'n1' } },
          `${stage}_n1`,
          0,
        ),
      ).resolves.toBeUndefined();
    } finally {
      capture.restore();
    }
    expect(jsonLines(capture.lines)).toHaveLength(0);
  });

  it('terminal failure (isAppError, non-retryable): logs exactly once and throws UnrecoverableError(describeError(error))', async () => {
    const capture = captureStdout();
    let thrown: unknown;
    try {
      await runJobStage(
        {
          stage,
          pipeline: 'test',
          schema,
          handler: () => {
            throw new NotFoundError('note missing');
          },
        },
        { data: { noteId: 'n2' } },
        `${stage}_n2`,
        0,
      );
    } catch (error) {
      thrown = error;
    } finally {
      capture.restore();
    }

    expect(thrown).toBeInstanceOf(UnrecoverableError);
    // describeError's step 1 (non-empty message) applies to a plain AppError.
    expect((thrown as Error).message).toBe('note missing');

    const lines = jsonLines(capture.lines);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ code: 'NOT_FOUND', reason: 'app-error-terminal:NOT_FOUND' });
  });

  it('retry (classifyRetry default for a foreign error): logs zero and rethrows the ORIGINAL error, not wrapped', async () => {
    const capture = captureStdout();
    let thrown: unknown;
    try {
      await runJobStage(
        {
          stage,
          pipeline: 'test',
          schema,
          handler: () => {
            throw new Error('transient blip');
          },
        },
        { data: { noteId: 'n3' } },
        `${stage}_n3`,
        0,
      );
    } catch (error) {
      thrown = error;
    } finally {
      capture.restore();
    }

    // A plain `Error` with no structured status/code classifies as rule 7 (unknown-default-retry)
    // — retried, not wrapped in UnrecoverableError; BullMQ's own attempts/backoff take it from here.
    expect(thrown).not.toBeInstanceOf(UnrecoverableError);
    expect((thrown as Error).message).toBe('transient blip');
    expect(jsonLines(capture.lines)).toHaveLength(0);
  });

  it('schema-parse failure: routes through the same terminal failSpan + UnrecoverableError shape', async () => {
    const capture = captureStdout();
    let thrown: unknown;
    try {
      await runJobStage(
        { stage, pipeline: 'test', schema, handler: async () => undefined },
        // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed payload
        { data: { noteId: 42 } as any },
        `${stage}_bad`,
        0,
      );
    } catch (error) {
      thrown = error;
    } finally {
      capture.restore();
    }

    expect(thrown).toBeInstanceOf(UnrecoverableError);
    const lines = jsonLines(capture.lines);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ code: 'VALIDATION' });
  });
});
