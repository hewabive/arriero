import { createHash, type Hash } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import type {
  FileVerificationProgress,
  HfContentHashAlgorithm,
} from "@arriero/core";

const HASH_READ_CHUNK_BYTES = 1024 * 1024;

export type VerificationObserver = (
  progress: FileVerificationProgress | null,
) => void;

export function hashReadStream(path: string, signal?: AbortSignal): ReadStream {
  return createReadStream(path, {
    highWaterMark: HASH_READ_CHUNK_BYTES,
    ...(signal ? { signal } : {}),
  });
}

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
  signal?: AbortSignal,
  onProgress?: VerificationObserver,
): Promise<string> {
  signal?.throwIfAborted();
  const hash = createHfContentHash(size, lfs);
  const started = performance.now();
  let lastReported = 0;
  let processedBytes = 0;
  const report = () => {
    const elapsed = performance.now() - started;
    onProgress?.({
      path,
      processedBytes,
      totalBytes: size,
      bytesPerSecond: elapsed >= 500 ? processedBytes / (elapsed / 1000) : null,
    });
  };
  report();
  for await (const chunk of hashReadStream(path, signal)) {
    hash.update(chunk as Buffer);
    processedBytes += (chunk as Buffer).length;
    const now = performance.now();
    if (lastReported === 0 || now - lastReported >= 200) {
      report();
      lastReported = now;
    }
    signal?.throwIfAborted();
  }
  signal?.throwIfAborted();
  report();
  return hash.digest("hex");
}
