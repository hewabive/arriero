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
