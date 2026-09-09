import { partialMatchKey, QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { apiQuery } from '../src/shared/api/index.js';
import { queryKeys } from '../src/shared/query-keys/index.js';

/**
 * The invalidation contract.
 *
 * This suite exists because a hand-written flat literal (`all: ['session']`) matches nothing at
 * all against an `@orpc/tanstack-query`-keyed query, so "invalidate this slice" would be a call
 * that looked right and did nothing. That is the failure class this repo keeps paying for, and the
 * only defence is asserting the MATCH rather than the key's spelling.
 *
 * Every assertion below is about behaviour under `partialMatchKey` / a real `QueryClient`. None of
 * them assert what a key literally equals — a key's spelling is not a property anybody depends on.
 */
describe('queryKeys ↔ oRPC key-space compatibility', () => {
  /** The exact shape `@orpc/tanstack-query` produces for the bootstrap query. */
  const liveBootstrapKey = [['session', 'bootstrap'], { type: 'query', input: undefined }];

  it('the namespace prefix matches this factory’s own per-query key', () => {
    expect(partialMatchKey(queryKeys.session.bootstrap(), queryKeys.session.all)).toBe(true);
  });

  /**
   * The regression guard proper: pinned as a NON-match so that anyone "simplifying" the factory
   * back to a flat array has to delete a test that says, in words, why they must not.
   */
  it('rejects the flat key shape a hand-written factory would produce — it matches nothing', () => {
    expect(partialMatchKey(liveBootstrapKey, ['session'])).toBe(false);
  });

  it('the factory’s prefix agrees with oRPC’s own generator', () => {
    expect(partialMatchKey(apiQuery.session.key(), queryKeys.session.all)).toBe(true);
  });

  /**
   * The strongest available assertion: the factory's key and the key a live query actually
   * registers under are the SAME key. This is what would catch the original defect at its source
   * rather than at its symptom — it compares the factory against oRPC, not against a hand-copied
   * shape that could be wrong in exactly the same way the factory was.
   */
  it('the per-query key IS the key a real queryOptions registers under', () => {
    expect(queryKeys.session.bootstrap()).toStrictEqual(
      apiQuery.session.bootstrap.queryOptions().queryKey,
    );
  });
});

describe('queryKeys against a real QueryClient', () => {
  /**
   * The behavioural proof, not the algebraic one: seed the cache with a query keyed exactly as
   * `apiQuery` keys it, invalidate by the slice prefix a feature would use, and assert the entry
   * actually went stale. `partialMatchKey` agreeing is necessary; a `QueryClient` agreeing is what
   * the slice depends on.
   */
  it('invalidating the slice prefix marks an apiQuery-keyed entry stale', async () => {
    const queryClient = new QueryClient();
    const liveKey = queryKeys.session.bootstrap();

    await queryClient.fetchQuery({ queryKey: liveKey, queryFn: () => ['seeded'] });
    expect(queryClient.getQueryState(liveKey)?.isInvalidated).toBe(false);

    await queryClient.invalidateQueries({ queryKey: queryKeys.session.all, refetchType: 'none' });

    expect(queryClient.getQueryState(liveKey)?.isInvalidated).toBe(true);
  });
});
