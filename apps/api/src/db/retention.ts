import { startAsyncIntervalLoop } from "../utils/interval-loop.js";

const HOURLY_MS = 60 * 60 * 1000;

export function startRetentionLoop(
  prune: () => unknown,
  options: { intervalMs?: number; onError?: (error: unknown) => void } = {},
): () => void {
  return startAsyncIntervalLoop(async () => prune(), {
    intervalMs: options.intervalMs ?? HOURLY_MS,
    onError: options.onError,
  });
}
