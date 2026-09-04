import { type InstanceMemoryDraw } from "@arriero/core";

import { createUiId } from "../utils/id";

const MEMORY_GIB = 1024 ** 3;

export type MemoryDraftRow = {
  id: string;
  poolId: string;
  gib: number | string;
};

export function memoryRowsFromDraws(
  draws: InstanceMemoryDraw[],
  rounding: "nearest" | "up" = "nearest",
): MemoryDraftRow[] {
  const round = rounding === "up" ? Math.ceil : Math.round;
  return draws.map((draw) => ({
    id: createUiId(),
    poolId: draw.poolId,
    gib: round((draw.bytes / MEMORY_GIB) * 100) / 100,
  }));
}

export function memoryDrawsFromRows(
  rows: MemoryDraftRow[],
): InstanceMemoryDraw[] {
  return rows
    .filter((row) => row.poolId && Number(row.gib) > 0)
    .map((row) => ({
      poolId: row.poolId,
      bytes: Math.round(Number(row.gib) * MEMORY_GIB),
    }));
}
