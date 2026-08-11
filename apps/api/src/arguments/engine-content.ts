import { resolve } from "node:path";

import { config } from "../config.js";

export function engineArgumentContentPaths(engineId: string) {
  const root = resolve(config.rootDir, "content", "engine-args", engineId);
  return {
    root,
    docsDirectory: resolve(root, "args"),
    snapshotPath: resolve(root, "source", "extract.json"),
    metadataPath: resolve(root, "source", "help-source.json"),
  };
}
