import { resolve, sep } from "node:path";

import { config } from "../config.js";

export function assertSafeConfigRelativePath(path: string): string {
  const plain =
    path.length > 0 &&
    path.length <= 512 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.endsWith("/") &&
    path
      .split("/")
      .every(
        (segment) => segment !== "" && segment !== "." && segment !== "..",
      );
  const contained =
    plain &&
    resolve(config.configDir, path).startsWith(
      resolve(config.configDir) + sep,
    );
  if (!contained) {
    throw new Error(`invalid configuration path: ${path}`);
  }
  return path;
}
