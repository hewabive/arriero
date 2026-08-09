import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const tsScanRoots = [
  "apps/api/src",
  "apps/web/src",
  "packages/core/src",
  "packages/anthropic-openai-bridge/src",
];

export function listFiles(dir, { extensions, exclude }) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(fullPath, { extensions, exclude }));
      continue;
    }

    if (
      entry.isFile() &&
      extensions.has(path.extname(entry.name)) &&
      !exclude?.test(entry.name)
    ) {
      files.push(fullPath);
    }
  }

  return files;
}

export function trackedFiles(root, pathspecs = []) {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", ...pathspecs],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  )
    .split("\n")
    .filter((line) => line.length > 0);
}
