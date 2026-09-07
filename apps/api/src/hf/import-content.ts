import { lstat } from "node:fs/promises";
import { hashHfContentFile } from "./content-hash.js";
import { HfDownloadRequestError } from "./paths.js";

const hashes = new Map<string, { identity: string; hash: string }>();
export async function importFileIdentity(path: string): Promise<string> {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile())
    throw new HfDownloadRequestError(`Not a regular file: ${path}`);
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}
export async function hashImportFile(
  path: string,
  size: number,
  lfs: boolean,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const identity = await importFileIdentity(path);
  const key = `${path}\0${lfs}`;
  const cached = hashes.get(key);
  if (cached?.identity === identity) return cached.hash;
  const hash = await hashHfContentFile(path, size, lfs, signal);
  if ((await importFileIdentity(path)) !== identity)
    throw new HfDownloadRequestError(
      `File changed during verification: ${path}`,
    );
  if (hashes.size >= 512) hashes.delete(hashes.keys().next().value!);
  hashes.set(key, { identity, hash });
  return hash;
}
