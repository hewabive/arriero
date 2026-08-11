export function startAsyncIntervalLoop(
  pass: () => Promise<unknown>,
  options: {
    intervalMs: number;
    immediate?: boolean;
    onError?: ((error: unknown) => void) | undefined;
  },
): () => void {
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
    return () => undefined;
  }

  let running = false;
  const tick = () => {
    if (running) {
      return;
    }
    running = true;
    void pass()
      .catch((error) => options.onError?.(error))
      .finally(() => {
        running = false;
      });
  };

  if (options.immediate) {
    tick();
  }
  const timer = setInterval(tick, options.intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
