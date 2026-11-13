/**
 * A value kept in this isolate's memory for `ttlMs`. Reads in other isolates
 * (and writes made elsewhere) are seen only once the entry expires, so use it
 * only for inputs where that much staleness is acceptable. A failed load is
 * not kept.
 */
export function isolateCache<T>(
  ttlMs: number,
  load: (binding: D1Database) => Promise<T>
) {
  let entry: { value: Promise<T>; expiresAt: number } | null = null;

  return {
    get(binding: D1Database): Promise<T> {
      const now = Date.now();

      if (entry && entry.expiresAt > now) return entry.value;
      const value = load(binding);
      const current = { value, expiresAt: now + ttlMs };
      entry = current;
      value.catch(() => {
        if (entry === current) entry = null;
      });

      return value;
    },
    /** Drops the entry, e.g. after this isolate changed the underlying rows. */
    clear() {
      entry = null;
    },
  };
}

/** How long workspace-wide inputs to the reader's sender checks are reused. */
export const WORKSPACE_CACHE_TTL_MS = 60_000;
