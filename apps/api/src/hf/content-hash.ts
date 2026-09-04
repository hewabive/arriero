import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";

export type HfContentHashAlgorithm = "sha256" | "git-sha1";

export function hfContentHashAlgorithm(lfs: boolean): HfContentHashAlgorithm {
  return lfs ? "sha256" : "git-sha1";
}

export function createHfContentHash(size: number, lfs: boolean): Hash {
  if (lfs) {
    return createHash("sha256");
  }
  const hash = createHash("sha1");
  hash.update(`blob ${size}\0`);
  return hash;
}

export async function hashHfContentFile(
  path: string,
  size: number,
  lfs: boolean,
): Promise<string> {
  const hash = createHfContentHash(size, lfs);
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}
