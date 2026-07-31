const HOURLY_MS = 60 * 60 * 1000;

export function startRetentionLoop(
  prune: () => unknown,
  options: { intervalMs?: number; onError?: (error: unknown) => void } = {},
): () => void {
  const timer = setInterval(() => {
    try {
      prune();
    } catch (error) {
      options.onError?.(error);
    }
  }, options.intervalMs ?? HOURLY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
