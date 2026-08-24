export type CachedSingleFlight<T> = {
  readCached: (key: string) => T | undefined;
  fetch: (key: string, load: () => Promise<T>) => Promise<T>;
};

export function createCachedSingleFlight<T>(
  ttlMs: number,
): CachedSingleFlight<T> {
  const cache = new Map<string, { at: number; value: T }>();
  const pending = new Map<string, Promise<T>>();
  return {
    readCached(key) {
      return cache.get(key)?.value;
    },
    fetch(key, load) {
      const cached = cache.get(key);
      if (cached && performance.now() - cached.at < ttlMs) {
        return Promise.resolve(cached.value);
      }
      const existing = pending.get(key);
      if (existing) {
        return existing;
      }
      const task = load()
        .then((value) => {
          cache.set(key, { at: performance.now(), value });
          return value;
        })
        .finally(() => {
          pending.delete(key);
        });
      pending.set(key, task);
      return task;
    },
  };
}
