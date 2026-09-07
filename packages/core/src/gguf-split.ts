export type SplitInfo = {
  prefix: string;
  index: number;
  count: number;
  indexWidth: number;
  countWidth: number;
};

export function parseSplitInfo(name: string): SplitInfo | null {
  const match = /^(?<prefix>.+)-(?<index>\d+)-of-(?<count>\d+)\.gguf$/i.exec(
    name,
  );
  const groups = match?.groups;
  if (!groups) {
    return null;
  }

  const prefix = groups.prefix;
  const indexText = groups.index;
  const countText = groups.count;
  const index = Number(indexText);
  const count = Number(countText);
  if (!prefix || !indexText || !countText) {
    return null;
  }
  if (!Number.isInteger(index) || !Number.isInteger(count)) {
    return null;
  }
  if (count <= 1 || index < 1 || index > count) {
    return null;
  }

  return {
    prefix,
    index,
    count,
    indexWidth: indexText.length,
    countWidth: countText.length,
  };
}

export function splitShardName(split: SplitInfo, index: number, count: number) {
  const indexText = String(index).padStart(split.indexWidth, "0");
  const countText = String(count).padStart(split.countWidth, "0");
  return `${split.prefix}-${indexText}-of-${countText}.gguf`;
}

export function groupGgufFiles<T>(
  files: readonly T[],
  pathOf: (file: T) => string,
): Array<{ files: T[]; complete: boolean }> {
  const groups = new Map<string, T[]>();
  for (const file of files) {
    const path = pathOf(file);
    const split = parseSplitInfo(path);
    const key = split ? splitShardName(split, 1, split.count) : path;
    const group = groups.get(key) ?? [];
    group.push(file);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    group.sort((a, b) =>
      pathOf(a).localeCompare(pathOf(b), undefined, { numeric: true }),
    );
    const split = parseSplitInfo(pathOf(group[0]!));
    const paths = new Set(group.map(pathOf));
    const complete =
      !split ||
      (paths.size === split.count &&
        group.length === split.count &&
        group.every((file) => {
          const member = parseSplitInfo(pathOf(file))!;
          return paths.has(splitShardName(split, member.index, split.count));
        }));
    return { files: group, complete };
  });
}
