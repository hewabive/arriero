import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../config.js";
import {
  isDiscardedDirectoryName,
  removeDiscardedDirectory,
} from "../utils/discard.js";
import { assertPathWithinRoot } from "../utils/path-guard.js";

export function webappDataDir(name: string): string {
  return assertWebappPath(resolve(config.webappsDir, name));
}

export function webappLogsDir(): string {
  return resolve(config.logsDir, "webapps");
}

function assertWebappPath(path: string): string {
  return assertPathWithinRoot(config.webappsDir, path, "webapp");
}

export function sweepWebappLeftovers(): number {
  if (!existsSync(config.webappsDir)) {
    return 0;
  }
  let swept = 0;
  for (const entry of readdirSync(config.webappsDir, { withFileTypes: true })) {
    if (!isDiscardedDirectoryName(entry.name)) {
      continue;
    }
    removeDiscardedDirectory(
      assertWebappPath(resolve(config.webappsDir, entry.name)),
    );
    swept += 1;
  }
  return swept;
}
