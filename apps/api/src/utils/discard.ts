import { randomUUID } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import { rm } from "node:fs/promises";

import { logger } from "../logger.js";

const TRASH_SUFFIX = ".trash";
const pendingRemovals = new Set<Promise<void>>();

export function isDiscardedDirectoryName(name: string): boolean {
  return name.endsWith(TRASH_SUFFIX);
}

export function removeDiscardedDirectory(path: string): void {
  const removal = rm(path, { recursive: true, force: true })
    .catch((error: unknown) => {
      logger.error({ error, path }, "discarded directory removal failed");
    })
    .finally(() => {
      pendingRemovals.delete(removal);
    });
  pendingRemovals.add(removal);
}

export function discardDirectory(path: string): void {
  if (!existsSync(path)) return;
  const trashPath = `${path}.${randomUUID().slice(0, 8)}${TRASH_SUFFIX}`;
  renameSync(path, trashPath);
  removeDiscardedDirectory(trashPath);
}

export function settleDirectoryDiscards(): Promise<void> {
  return Promise.all([...pendingRemovals]).then(() => undefined);
}
