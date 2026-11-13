/**
 * Runs `task` for each item with at most `limit` running at once, taking
 * items in order as tasks finish. The first task that fails stops taking
 * new items; the ones already running finish, the source is closed (an
 * async generator's `finally` runs) and that first failure is thrown.
 */
export async function forEachConcurrent<Item>(
  items: AsyncIterable<Item> | Iterable<Item>,
  limit: number,
  task: (item: Item, index: number) => Promise<void>
): Promise<void> {
  // An async generator queues concurrent next() calls, so workers can share it.
  const source = (async function* () {
    yield* items;
  })();

  let taken = 0;
  let stopped = false;
  const failures: Promise<void>[] = [];

  const work = async () => {
    /* oxlint-disable eslint/no-await-in-loop -- a worker takes its next item only when its last task is done: that is the concurrency bound */
    for (;;) {
      // Set by another worker's failure while this one waited.
      if (stopped) return;
      const next = await source.next();

      if (next.done) return;
      const index = taken;
      taken += 1;
      await task(next.value, index);
    }
    /* oxlint-enable eslint/no-await-in-loop */
  };

  const worker = async () => {
    const running = work();

    try {
      await running;
    } catch {
      stopped = true;
      failures.push(running);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker));
  await source.return(undefined);

  // Rethrows the first failure, as it was thrown.
  if (failures.length > 0) await failures[0];
}
