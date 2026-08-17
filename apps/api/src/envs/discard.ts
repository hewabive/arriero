import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, renameSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import { config } from "../config.js";
import { logger } from "../logger.js";
import { ENVIRONMENT_STAGING_SUFFIX, assertEnvironmentPath } from "./paths.js";

const TRASH_SUFFIX = ".trash";
const pendingRemovals = new Set<Promise<void>>();

export function isDiscardedEnvironmentName(name: string): boolean {
  return name.endsWith(TRASH_SUFFIX);
}

function removeDiscardedEnvironmentDirectory(path: string): void {
  const removal = rm(path, { recursive: true, force: true })
    .catch((error: unknown) => {
      logger.error(
        { error, path },
        "discarded environment directory removal failed",
      );
    })
    .finally(() => {
      pendingRemovals.delete(removal);
    });
  pendingRemovals.add(removal);
}

export function discardEnvironmentDirectory(path: string): void {
  if (!existsSync(path)) return;
  const trashPath = `${path}.${randomUUID().slice(0, 8)}${TRASH_SUFFIX}`;
  renameSync(path, trashPath);
  removeDiscardedEnvironmentDirectory(trashPath);
}

export function sweepEnvironmentLeftovers(): number {
  let swept = 0;
  for (const entry of readdirSync(config.envsDir, { withFileTypes: true })) {
    const path = assertEnvironmentPath(resolve(config.envsDir, entry.name));
    if (entry.name.endsWith(ENVIRONMENT_STAGING_SUFFIX)) {
      discardEnvironmentDirectory(path);
    } else if (isDiscardedEnvironmentName(entry.name)) {
      removeDiscardedEnvironmentDirectory(path);
    } else {
      continue;
    }
    swept += 1;
  }
  return swept;
}

export function settleEnvironmentDiscards(): Promise<void> {
  return Promise.all([...pendingRemovals]).then(() => undefined);
}
