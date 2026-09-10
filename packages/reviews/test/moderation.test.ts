/**
 * `setReviewModerationState` (TASK-0009) — unit-level proof of its no-op/target-state logic
 * against a fake `Kysely<unknown>` built on Kysely's REAL `PostgresDialect` (the identical
 * technique `apps/api/test/harness/fake-postgres.ts` uses for its own HTTP-layer proofs): every
 * `sql` tagged template this function issues compiles exactly as it would against real Postgres,
 * and `respond` pattern-matches the compiled SQL text against an in-memory single-row store. No
 * Docker, no container — the container-level proof that reject/restore commit their outbox row in
 * the SAME transaction as the state change (against REAL Postgres) is
 * `test-integration/moderation.test.ts`; this file proves the pipeline's BRANCHING logic (already
 * at target vs. genuinely transitioning vs. racing) with the database held fixed and inspectable.
 *
 * MUTATION PERFORMED AND RESTORED (ADR-0010, CLAUDE.md's testing standard): in
 * `src/moderation.ts`'s `setReviewModerationState`, the early
 * `if (before.review_moderation_state_id === targetStateId) { ... return ...}` no-op branch was
 * temporarily deleted, falling through to the transaction/UPDATE path unconditionally. Under that
 * mutation, "already at target state" no longer short-circuits: the `UPDATE ... WHERE
 * review_moderation_state_id = ${before.review_moderation_state_id}` still matches (the row's own
 * current value), so the statement "succeeds" (rewriting the column to the SAME id) and
 * `emitRatingRecompute` fires — a spurious second outbox row for a transition that never actually
 * happened. The "already-published, reject target published" test below went from green (zero
 * outbox statements) to RED (one outbox INSERT observed) under that mutation, and from green to RED
 * on the "returns the current row without opening a transaction" assertion too (an advisory-lock
 * statement newly appeared). The early-return branch was then restored and this suite re-run green.
 */
import { NotFoundError } from '@repo/kernel';
import {
  Kysely,
  type PostgresCursor,
  PostgresDialect,
  type PostgresPool,
  type PostgresPoolClient,
  type PostgresQueryResult,
} from 'kysely';
import { describe, expect, it } from 'vitest';
import { setReviewModerationState } from '../src/moderation.js';

const PUBLISHED_ID = 1;
const REJECTED_ID = 3;

interface FakeReviewRow {
  token: string;
  product_id: string;
  author_id: string;
  rating: number;
  title: string;
  body: string;
  review_moderation_state_id: number;
  created_at: Date;
  updated_at: Date;
}

interface CapturedStatement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

function baseRow(overrides: Partial<FakeReviewRow> = {}): FakeReviewRow {
  return {
    token: 'rev_AAAAAAAAAAAAAAAAAAAAA',
    product_id: 'product-1',
    author_id: 'author-1',
    rating: 4,
    title: 'A perfectly ordinary review',
    body: 'Long enough to satisfy the length checks this fake never enforces.',
    review_moderation_state_id: PUBLISHED_ID,
    created_at: new Date('2024-01-01T00:00:00.000Z'),
    updated_at: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/**
 * A fake `Kysely<unknown>` over an in-memory single review row, exercising the REAL query compiler
 * (same technique `apps/api/test/harness/fake-postgres.ts` documents). `startingRow: undefined`
 * simulates an unknown token. `onFirstRead` fires once, immediately after the FIRST `SELECT`
 * responds — used to simulate a concurrent transition landing between this function's
 * pre-transaction read and its later `UPDATE` (the race branch).
 */
function buildFakeDb(
  startingRow: FakeReviewRow | undefined,
  options: { readonly onFirstRead?: (current: FakeReviewRow) => FakeReviewRow } = {},
): { readonly db: Kysely<unknown>; readonly statements: readonly CapturedStatement[] } {
  let row = startingRow;
  const statements: CapturedStatement[] = [];
  let selectCount = 0;

  function query<R>(
    sqlText: string,
    parameters: ReadonlyArray<unknown>,
  ): Promise<PostgresQueryResult<R>>;
  function query<R>(cursor: PostgresCursor<R>): PostgresCursor<R>;
  function query<R>(
    sqlOrCursor: string | PostgresCursor<R>,
    parameters?: ReadonlyArray<unknown>,
  ): Promise<PostgresQueryResult<R>> | PostgresCursor<R> {
    if (typeof sqlOrCursor !== 'string') {
      throw new Error('buildFakeDb: the cursor form of query() is not supported by this fake');
    }
    const sqlText = sqlOrCursor;
    const params = parameters ?? [];
    statements.push({ sql: sqlText, parameters: params });
    const lower = sqlText.toLowerCase();

    let rows: unknown[] = [];
    let command: PostgresQueryResult<unknown>['command'] = 'SELECT';

    if (lower.includes('from reviews.review') && lower.includes('where token')) {
      selectCount += 1;
      rows = row === undefined ? [] : [{ ...row }];
      if (selectCount === 1 && options.onFirstRead && row !== undefined) {
        row = options.onFirstRead(row);
      }
    } else if (lower.includes('pg_advisory_xact_lock')) {
      rows = [];
    } else if (lower.includes('update reviews.review')) {
      command = 'UPDATE';
      const [targetStateId, reviewToken, expectedStateId] = params as [number, string, number];
      if (
        row !== undefined &&
        row.token === reviewToken &&
        row.review_moderation_state_id === expectedStateId
      ) {
        row = {
          ...row,
          review_moderation_state_id: targetStateId,
          updated_at: new Date(row.updated_at.getTime() + 1),
        };
        rows = [{ ...row }];
      } else {
        rows = [];
      }
    } else if (lower.includes('insert into') && lower.includes('outbox')) {
      command = 'INSERT';
      rows = [];
    }
    // Transaction-control statements (begin/commit/rollback) fall through to `rows: []` — this
    // fake, like `fake-postgres.ts`'s, does not need to understand them.

    return Promise.resolve({ command, rowCount: rows.length, rows: rows as R[] });
  }

  const client = {
    processID: 1,
    query,
    release(): void {
      // no-op
    },
  };
  const pool: PostgresPool = {
    connect: () => Promise.resolve(client as unknown as PostgresPoolClient),
    end: () => Promise.resolve(),
    options: {},
  };

  return {
    db: new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }),
    statements,
  };
}

function countMatching(
  statements: readonly CapturedStatement[],
  predicate: (sql: string) => boolean,
): number {
  return statements.filter((s) => predicate(s.sql.toLowerCase())).length;
}

describe('setReviewModerationState: already-at-target is a no-op (TASK-0009 AC)', () => {
  it('rejecting an already-rejected review returns the current row, opens no transaction, and enqueues no outbox row', async () => {
    const { db, statements } = buildFakeDb(baseRow({ review_moderation_state_id: REJECTED_ID }));

    const result = await setReviewModerationState(db, {
      reviewToken: 'rev_AAAAAAAAAAAAAAAAAAAAA',
      targetState: 'rejected',
    });

    expect(result.moderationState).toBe('rejected');
    expect(result.token).toBe('rev_AAAAAAAAAAAAAAAAAAAAA');
    expect(countMatching(statements, (s) => s.includes('update reviews.review'))).toBe(0);
    expect(countMatching(statements, (s) => s.includes('outbox'))).toBe(0);
    expect(countMatching(statements, (s) => s.includes('pg_advisory_xact_lock'))).toBe(0);
    // Exactly the ONE pre-transaction read — nothing else was ever issued.
    expect(statements).toHaveLength(1);
  });

  it('restoring an already-published review returns the current row, opens no transaction, and enqueues no outbox row', async () => {
    const { db, statements } = buildFakeDb(baseRow({ review_moderation_state_id: PUBLISHED_ID }));

    const result = await setReviewModerationState(db, {
      reviewToken: 'rev_AAAAAAAAAAAAAAAAAAAAA',
      targetState: 'published',
    });

    expect(result.moderationState).toBe('published');
    expect(countMatching(statements, (s) => s.includes('update reviews.review'))).toBe(0);
    expect(countMatching(statements, (s) => s.includes('outbox'))).toBe(0);
    expect(statements).toHaveLength(1);
  });
});

describe('setReviewModerationState: a genuine transition (TASK-0009)', () => {
  it('rejecting a published review issues exactly one UPDATE and one outbox INSERT, and returns the new state', async () => {
    const { db, statements } = buildFakeDb(baseRow({ review_moderation_state_id: PUBLISHED_ID }));

    const result = await setReviewModerationState(db, {
      reviewToken: 'rev_AAAAAAAAAAAAAAAAAAAAA',
      targetState: 'rejected',
    });

    expect(result.moderationState).toBe('rejected');
    expect(result.authorId).toBe('author-1');
    expect(countMatching(statements, (s) => s.includes('pg_advisory_xact_lock'))).toBe(1);
    expect(countMatching(statements, (s) => s.includes('update reviews.review'))).toBe(1);
    expect(
      countMatching(statements, (s) => s.includes('insert into') && s.includes('outbox')),
    ).toBe(1);
  });

  it('restoring a rejected review issues exactly one UPDATE and one outbox INSERT, and returns the new state', async () => {
    const { db, statements } = buildFakeDb(baseRow({ review_moderation_state_id: REJECTED_ID }));

    const result = await setReviewModerationState(db, {
      reviewToken: 'rev_AAAAAAAAAAAAAAAAAAAAA',
      targetState: 'published',
    });

    expect(result.moderationState).toBe('published');
    expect(countMatching(statements, (s) => s.includes('update reviews.review'))).toBe(1);
    expect(
      countMatching(statements, (s) => s.includes('insert into') && s.includes('outbox')),
    ).toBe(1);
  });
});

describe('setReviewModerationState: a race between the pre-transaction read and the lock (TASK-0009)', () => {
  // Mutation: in `src/moderation.ts`'s `setReviewModerationState`, change the race branch's
  // `readModerationRow(trx, input.reviewToken)` re-read to instead re-throw the zero-row `UPDATE`
  // as an unhandled error — this test's `moderationState` assertion goes red (the call rejects
  // instead of resolving), and the "still enqueues nothing" assertion below would no longer even
  // run.
  it('a concurrent identical transition landing between the read and the lock is absorbed as a no-op, not a second write', async () => {
    const { db, statements } = buildFakeDb(baseRow({ review_moderation_state_id: PUBLISHED_ID }), {
      // Simulates another moderator's transaction committing the SAME transition right after this
      // call's own pre-transaction read observed `published` — by the time this call's `UPDATE`
      // runs, the row is already `rejected`.
      onFirstRead: (current) => ({
        ...current,
        review_moderation_state_id: REJECTED_ID,
        updated_at: new Date(current.updated_at.getTime() + 1),
      }),
    });

    const result = await setReviewModerationState(db, {
      reviewToken: 'rev_AAAAAAAAAAAAAAAAAAAAA',
      targetState: 'rejected',
    });

    expect(result.moderationState).toBe('rejected');
    // The UPDATE's optimistic re-assertion (`WHERE review_moderation_state_id = published`) missed
    // — the row was already `rejected` — so it affected zero rows, and the race branch re-read
    // instead of writing again.
    expect(countMatching(statements, (s) => s.includes('update reviews.review'))).toBe(1);
    expect(
      countMatching(statements, (s) => s.includes('insert into') && s.includes('outbox')),
    ).toBe(0);
    // Two SELECTs: the pre-transaction read and the post-race re-read under the lock.
    expect(
      countMatching(
        statements,
        (s) => s.includes('from reviews.review') && s.includes('where token'),
      ),
    ).toBe(2);
  });
});

describe('setReviewModerationState: an unknown token (TASK-0009, SPEC-0003)', () => {
  it('throws NotFoundError without ever opening a transaction', async () => {
    const { db, statements } = buildFakeDb(undefined);

    await expect(
      setReviewModerationState(db, {
        reviewToken: 'rev_ZZZZZZZZZZZZZZZZZZZZZ',
        targetState: 'rejected',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(countMatching(statements, (s) => s.includes('pg_advisory_xact_lock'))).toBe(0);
    expect(statements).toHaveLength(1);
  });
});
