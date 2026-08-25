import { accessSync, constants, existsSync } from "node:fs";

export function executableError(
  path: string,
  description: string,
): string | null {
  if (!existsSync(path)) return `${description} is missing: ${path}`;
  try {
    accessSync(path, constants.X_OK);
    return null;
  } catch {
    return `${description} is not executable: ${path}`;
  }
}
