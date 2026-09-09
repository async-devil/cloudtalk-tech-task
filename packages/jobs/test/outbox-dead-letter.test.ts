import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { writeOutboxDeadLetter } from '../src/index.js';

/**
 * `writeOutboxDeadLetter`'s own behaviour (SPEC-0004), proven without a database: reason
 * truncation, and the uuid guard's decision. The DB-backed half — the row actually landing, the
 * `ON CONFLICT DO NOTHING` replay guard, and `relayOutboxBatch`'s parking branch calling this at
 * all — is `test-integration/outbox.test.ts`'s job; this file proves only what needs no container.
 */

interface CapturedValueNode {
  readonly kind: string;
  readonly value?: unknown;
}

interface CapturedRawNode {
  readonly parameters: ReadonlyArray<CapturedValueNode>;
}

/**
 * A `Kysely<unknown>`-shaped fake whose "executor" is just enough of Kysely's internal
 * `QueryExecutor` protocol for `sql\`...\`.execute(db)` to run: identity `transformQuery`/
 * `compileQuery` (this file's plain `sql` tags never attach a plugin, so neither call needs to do
 * anything) and an `executeQuery` that captures the raw operation node instead of reaching a
 * driver. Kysely lowers each `${...}` interpolation in a tagged template to a
 * `{ kind: 'ValueNode', value }` node in that node's own `parameters` array, in the template's
 * order — which is what lets the assertions below read back exactly what `writeOutboxDeadLetter`
 * was about to send to Postgres, with no Postgres involved.
 */
function createCapturingDb(): {
  db: Kysely<unknown>;
  captured: () => CapturedRawNode | undefined;
} {
  let captured: CapturedRawNode | undefined;
  const executor = {
    transformQuery: (node: unknown) => node,
    compileQuery: (node: unknown) => node,
    executeQuery: (node: CapturedRawNode) => {
      captured = node;
      return Promise.resolve({ rows: [] });
    },
  };
  const db = { getExecutor: () => executor } as unknown as Kysely<unknown>;
  return { db, captured: () => captured };
}

// `INSERT INTO jobs.dead_letter (pipeline, instance_id, stage, reason, attempts) VALUES
// (${pipeline}, ${instanceId}, ${stage}, ${reason}, ${attempts})` — reason is the 4th
// interpolation (index 3).
const REASON_PARAM_INDEX = 3;

describe('writeOutboxDeadLetter (SPEC-0004): reason truncation', () => {
  it('truncates a reason over REASON_MAX_LENGTH (500) before it reaches the INSERT', async () => {
    const { db, captured } = createCapturingDb();

    await writeOutboxDeadLetter(db, {
      pipeline: 'reviews',
      instanceId: crypto.randomUUID(),
      stage: 'reviews-outbox-relay',
      reason: 'x'.repeat(600),
      attempts: 5,
    });

    // Mutation: in `src/dead-letter.ts`'s `writeOutboxDeadLetter`, pass `record.reason` straight
    // to the INSERT instead of `truncateReason(record.reason)` — this assertion goes red (600, not
    // 500).
    const reasonParam = captured()?.parameters[REASON_PARAM_INDEX];
    expect(reasonParam?.kind).toBe('ValueNode');
    expect(reasonParam?.value).toBe('x'.repeat(500));
  });

  it('leaves a reason at or under the limit untouched', async () => {
    const { db, captured } = createCapturingDb();

    await writeOutboxDeadLetter(db, {
      pipeline: 'reviews',
      instanceId: crypto.randomUUID(),
      stage: 'reviews-outbox-relay',
      reason: 'provider permanently rejected the request',
      attempts: 1,
    });

    expect(captured()?.parameters[REASON_PARAM_INDEX]?.value).toBe(
      'provider permanently rejected the request',
    );
  });
});

describe('writeOutboxDeadLetter (SPEC-0004): the uuid guard', () => {
  it('skips the INSERT entirely when instanceId is not a uuid — parking must never depend on its own triage record', async () => {
    // A db that throws the moment anything tries to reach it — proves the non-uuid branch never
    // attempts the INSERT at all, not merely that it swallows a failure from one.
    const unreachableDb = {
      getExecutor: () => {
        throw new Error(
          'writeOutboxDeadLetter must not touch the database for a non-uuid instanceId',
        );
      },
    } as unknown as Kysely<unknown>;

    // Mutation: in `src/dead-letter.ts`'s `writeOutboxDeadLetter`, delete the `if (!UUID_RE.test(...))
    // { ...; return; }` guard — this call then reaches `unreachableDb.getExecutor()` and the
    // promise rejects instead of resolving.
    await expect(
      writeOutboxDeadLetter(unreachableDb, {
        pipeline: 'some_pipeline',
        instanceId: 'not-a-uuid',
        stage: 'some-pipeline-outbox-relay',
        reason: 'poison row apply failure',
        attempts: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it('does not false-positive: a genuine uuid instanceId still reaches the INSERT', async () => {
    const { db, captured } = createCapturingDb();

    // Mutation: tighten `UUID_RE` (e.g. require an uppercase-only match, or add an anchor that a
    // real `crypto.randomUUID()` output cannot satisfy) — this assertion goes red (`captured()`
    // stays `undefined`, since the guard would now also skip a valid uuid).
    await writeOutboxDeadLetter(db, {
      pipeline: 'reviews',
      instanceId: crypto.randomUUID(),
      stage: 'reviews-outbox-relay',
      reason: 'poison row apply failure',
      attempts: 3,
    });

    expect(captured()).toBeDefined();
  });
});
