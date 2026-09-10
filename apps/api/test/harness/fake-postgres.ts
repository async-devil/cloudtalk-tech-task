/**
 * A `Kysely<unknown>` backed by Kysely's REAL `PostgresDialect` — its real query compiler and
 * adapter, so every `sql` tagged template a capability module writes compiles exactly as it would
 * against real Postgres — wired to a FAKE `pg`-shaped pool instead of a socket. No Docker, no
 * network: a `respond` callback pattern-matches the compiled SQL text and hands back canned rows.
 *
 * This is what lets `apps/api/test/`'s plain (non-container) suite drive the REAL capability-
 * module code (`@repo/auth`'s `resolveRequestSession`, `@repo/reviews`'s `updateReview`/
 * `removeReview`) through the REAL built app — the HTTP-layer proof TASK-0003 asks for ("asserted
 * at the HTTP layer rather than in a unit test of the guard") — without needing the Testcontainers
 * Postgres that `packages/reviews/test-integration/` uses for its own, different proof (real
 * pagination over real rows).
 *
 * Only the three `PostgresPool`/`PostgresPoolClient` methods Kysely's driver actually calls are
 * implemented (`connect`, `query`, `release`, `end`) — all three interfaces are `kysely`'s own
 * public types, so the `pool` object itself needs no cast to satisfy `PostgresDialectConfig.pool`.
 * `query`'s implementation carries the one unavoidable cast: `R` is chosen by the capability-
 * module query at the Kysely call site, and this fake has no schema to prove `respond`'s canned
 * rows actually match it — trusting that shape is the fake's entire contract (see the comment at
 * the cast site).
 */
import {
  Kysely,
  type PostgresCursor,
  PostgresDialect,
  type PostgresPool,
  type PostgresQueryResult,
} from 'kysely';

export interface FakeQueryResult<R = unknown> {
  readonly rows: readonly R[];
  /** @default inferred from the SQL text's leading keyword */
  readonly command?: PostgresQueryResult<unknown>['command'];
}

export type FakeQueryResponder = (sql: string, parameters: readonly unknown[]) => FakeQueryResult;

function inferCommand(sql: string): PostgresQueryResult<unknown>['command'] {
  const keyword = sql.trim().split(/\s+/, 1)[0]?.toUpperCase();
  if (keyword === 'UPDATE' || keyword === 'DELETE' || keyword === 'INSERT') {
    return keyword;
  }
  return 'SELECT';
}

/** Builds the fake db. `respond` is called once per statement Kysely sends — including
 * transaction control statements (`begin`/`commit`/`rollback`), which a responder that only cares
 * about its own domain statements can safely ignore by returning `{ rows: [] }` for anything it
 * does not recognise. */
export function fakePostgresDb(respond: FakeQueryResponder): Kysely<unknown> {
  // `PostgresPoolClient.query` is an overload pair — a two-argument (sql, parameters) form AND a
  // one-argument cursor form (`pg-cursor`, streaming reads). Kysely's own driver only ever calls
  // the first; declaring both overload signatures here (rather than a single widened signature)
  // is what lets `client` satisfy `PostgresPoolClient` structurally.
  function query<R>(
    sql: string,
    parameters: ReadonlyArray<unknown>,
  ): Promise<PostgresQueryResult<R>>;
  function query<R>(cursor: PostgresCursor<R>): PostgresCursor<R>;
  function query<R>(
    sqlOrCursor: string | PostgresCursor<R>,
    parameters?: ReadonlyArray<unknown>,
  ): Promise<PostgresQueryResult<R>> | PostgresCursor<R> {
    if (typeof sqlOrCursor !== 'string') {
      throw new Error(
        'fakePostgresDb: the cursor form of query() is not supported by this fake — only the ' +
          '(sql, parameters) overload Kysely itself calls is implemented',
      );
    }
    const result = respond(sqlOrCursor, parameters ?? []);
    return Promise.resolve({
      command: result.command ?? inferCommand(sqlOrCursor),
      rowCount: result.rows.length,
      // The one fake-boundary cast (same shape as `factory.ts`'s "one better-auth boundary
      // cast"): `R` is the row shape the CALLING capability-module query expects, chosen at the
      // Kysely call site — this generic `query` has no schema to parse it against. `respond` IS
      // the fake's contract: the test author supplies rows shaped to match the SQL it recognises,
      // so trusting that shape here is exactly what a hand-written fake response is for.
      rows: [...result.rows] as R[],
    });
  }

  const client = {
    processID: 1,
    query,
    release(): void {
      // no-op: nothing to return to a real pool
    },
  };

  const pool: PostgresPool = {
    connect: () => Promise.resolve(client),
    end: () => Promise.resolve(),
    options: {},
  };

  return new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
}

/**
 * A `db` that throws the instant anything touches it — the positive proof half of "an anonymous
 * write is answered 401 without reaching the pipeline" (TASK-0003). Passing this as
 * `HttpHandlerDeps.db` alongside no `session` dependency means the only way a request could ever
 * get past `requireSession`'s 401 is if this object were read — so a response that is cleanly 401
 * (not a 500 from this throwing) is a genuine proof the capability module was never called, not
 * merely an absence of evidence.
 */
export function poisonedDb(): Kysely<unknown> {
  return new Proxy(
    {},
    {
      get(_target, property): never {
        throw new Error(
          `poisonedDb: "${String(property)}" was accessed — the write pipeline ran when it ` +
            'should have been rejected before touching the database',
        );
      },
    },
  ) as unknown as Kysely<unknown>;
}
