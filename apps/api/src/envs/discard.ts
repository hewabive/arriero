import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../config.js";
import {
  discardDirectory,
  isDiscardedDirectoryName,
  removeDiscardedDirectory,
} from "../utils/discard.js";
import { ENVIRONMENT_STAGING_SUFFIX, assertEnvironmentPath } from "./paths.js";

export function sweepEnvironmentLeftovers(): number {
  let swept = 0;
  for (const entry of readdirSync(config.envsDir, { withFileTypes: true })) {
    const path = assertEnvironmentPath(resolve(config.envsDir, entry.name));
    if (entry.name.endsWith(ENVIRONMENT_STAGING_SUFFIX)) {
      discardDirectory(path);
    } else if (isDiscardedDirectoryName(entry.name)) {
      removeDiscardedDirectory(path);
    } else {
      continue;
    }
    swept += 1;
  }
  return swept;
}
