import type { NumaPlacement } from "@arriero/core";

const NUMA_SKEW_TOLERANCE = 0.5;

export function parseNumaMaps(content: string): Map<number, number> {
  const perNode = new Map<number, number>();
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const pageSizeMatch = /\bkernelpagesize_kB=(\d+)\b/.exec(line);
    const pageBytes = (pageSizeMatch ? Number(pageSizeMatch[1]) : 4) * 1024;
    for (const match of line.matchAll(/\bN(\d+)=(\d+)\b/g)) {
      const node = Number(match[1]);
      const pages = Number(match[2]);
      if (!Number.isInteger(node) || !Number.isFinite(pages)) {
        continue;
      }
      perNode.set(node, (perNode.get(node) ?? 0) + pages * pageBytes);
    }
  }
  return perNode;
}

export function computeNumaPlacement(input: {
  perNodeBytes: Map<number, number>;
  interleaveNodeCount: number;
  tolerance?: number;
}): NumaPlacement | null {
  if (input.interleaveNodeCount <= 1) {
    return null;
  }
  const perNode = [...input.perNodeBytes.entries()]
    .map(([node, bytes]) => ({ node, bytes }))
    .sort((left, right) => left.node - right.node);
  const totalBytes = perNode.reduce((sum, entry) => sum + entry.bytes, 0);
  if (totalBytes <= 0) {
    return null;
  }

  const maxBytes = perNode.reduce(
    (max, entry) => Math.max(max, entry.bytes),
    0,
  );
  const maxNodeShare = maxBytes / totalBytes;
  const idealShare = 1 / input.interleaveNodeCount;
  const tolerance = input.tolerance ?? NUMA_SKEW_TOLERANCE;

  return {
    perNode,
    totalBytes,
    maxNodeSharePct: Math.round(maxNodeShare * 100),
    idealSharePct: Math.round(idealShare * 100),
    even: maxNodeShare <= idealShare * (1 + tolerance),
    interleaveNodeCount: input.interleaveNodeCount,
  };
}
