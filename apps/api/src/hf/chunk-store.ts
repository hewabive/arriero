import { existsSync, rmSync, statSync } from "node:fs";
import { z } from "zod";

import { atomicWriteFile } from "../utils/atomic-write.js";
import { readValidatedJsonFile } from "../utils/json-file.js";

const HfChunkSidecarSchema = z.object({
  version: z.literal(1),
  size: z.number().int().nonnegative(),
  chunkBytes: z.number().int().positive(),
  oid: z.string().min(1),
  lfs: z.boolean(),
  revision: z.string().min(1),
  completed: z.array(z.number().int().nonnegative()),
});

export type HfChunkSidecar = z.infer<typeof HfChunkSidecarSchema>;

export function hfChunkSidecarPath(finalPath: string): string {
  return `${finalPath}.part.json`;
}

export function chunkCountFor(size: number, chunkBytes: number): number {
  return Math.max(1, Math.ceil(size / chunkBytes));
}

export function chunkSizeAt(
  size: number,
  chunkBytes: number,
  index: number,
): number {
  return Math.min(chunkBytes, size - index * chunkBytes);
}

export function readHfChunkSidecar(finalPath: string): HfChunkSidecar | null {
  return readValidatedJsonFile(
    hfChunkSidecarPath(finalPath),
    HfChunkSidecarSchema,
    "hf chunk sidecar",
  );
}

export function writeHfChunkSidecar(
  finalPath: string,
  sidecar: HfChunkSidecar,
): void {
  atomicWriteFile(
    hfChunkSidecarPath(finalPath),
    `${JSON.stringify({ ...sidecar, completed: [...sidecar.completed].sort((a, b) => a - b) })}\n`,
  );
}

export function removeHfChunkSidecar(finalPath: string): void {
  rmSync(hfChunkSidecarPath(finalPath), { force: true });
}

export function partialBytesFor(finalPath: string): number {
  const partPath = `${finalPath}.part`;
  if (!existsSync(partPath)) {
    return 0;
  }
  const sidecar = readHfChunkSidecar(finalPath);
  if (sidecar) {
    return sidecar.completed.reduce(
      (sum, index) =>
        sum + Math.max(0, chunkSizeAt(sidecar.size, sidecar.chunkBytes, index)),
      0,
    );
  }
  try {
    return statSync(partPath).size;
  } catch {
    return 0;
  }
}
