const DEFAULT_LADDER = [1, 2, 5, 10];

export function niceCeiling(
  value: number,
  ladder: readonly number[] = DEFAULT_LADDER,
): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of ladder) {
    if (value <= step * magnitude) {
      return step * magnitude;
    }
  }
  return 10 * magnitude;
}
