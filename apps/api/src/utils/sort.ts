export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortedByKey<T>(
  items: readonly T[],
  key: (item: T) => string,
): T[] {
  return [...items].sort((left, right) =>
    compareStrings(key(left), key(right)),
  );
}
