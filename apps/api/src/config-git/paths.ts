import { isPlainRelativeConfigGitPath } from "@arriero/core";

export function assertSafeConfigRelativePath(path: string): string {
  if (!isPlainRelativeConfigGitPath(path)) {
    throw new Error(`invalid configuration path: ${path}`);
  }
  return path;
}
