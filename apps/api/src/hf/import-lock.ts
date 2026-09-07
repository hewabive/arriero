import { isPathWithin } from "../path-utils.js";
import { HfDownloadConflictError } from "./download-plan.js";

const locked = new Set<string>();
export function assertNoModelImport(path: string): void {
  if (
    [...locked].some(
      (entry) => isPathWithin(entry, path) || isPathWithin(path, entry),
    )
  )
    throw new HfDownloadConflictError(`Model import is using ${path}`);
}
export function lockModelImport(paths: string[]): () => void {
  paths.forEach(assertNoModelImport);
  paths.forEach((path) => locked.add(path));
  return () => paths.forEach((path) => locked.delete(path));
}
