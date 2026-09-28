export function percentileOfSorted(
  sorted: readonly number[],
  quantile: number,
): number | null {
  const rank = (sorted.length - 1) * quantile;
  const lower = sorted[Math.floor(rank)];
  const upper = sorted[Math.ceil(rank)];
  return lower === undefined || upper === undefined
    ? null
    : lower + (upper - lower) * (rank - Math.floor(rank));
}

export function percentile(
  values: readonly number[],
  quantile: number,
): number | null {
  return percentileOfSorted(
    [...values].sort((left, right) => left - right),
    quantile,
  );
}

export function knownSum(values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) {
      return null;
    }
    total += value;
  }
  return total;
}

export function maxKnown(values: readonly (number | null)[]): number | null {
  let highest: number | null = null;
  for (const value of values) {
    if (value !== null && (highest === null || value > highest)) {
      highest = value;
    }
  }
  return highest;
}
