/**
 * Runs `task` over `items` with at most `limit` running at once — a fixed-width pool of workers
 * pulling from a shared cursor. Completion order is not preserved, so `task`s MUST be independent.
 *
 * The reconciler uses this to overlap the I/O of its per-instance stale-row transactions (
 * amendment, review): each transaction takes that instance's own advisory lock, so distinct
 * instances never contend, yet a bounded width keeps the number of concurrent Postgres transactions
 * well within a normal connection pool even when a backlog runs to hundreds of stale rows. A
 * `limit` of 1 is exactly the original serial behavior.
 */
export async function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  const width = Math.min(Math.max(1, limit), items.length);
  if (width === 0) {
    return;
  }
  let cursor = 0;
  const runWorker = async (): Promise<void> => {
    for (;;) {
      // Read-then-increment is atomic between `await`s (single-threaded JS): no two workers ever
      // claim the same index.
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      const item = items[index];
      if (item === undefined) {
        return;
      }
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: width }, runWorker));
}
