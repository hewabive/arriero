import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function nvmNodeDirectories(home: string): string[] {
  const root = join(home, ".nvm", "versions", "node");
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name, "bin"));
  } catch {
    return [];
  }
}

export function wellKnownToolDirectories(
  home = homedir(),
  platform = process.platform,
): string[] {
  const directories = [
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/snap/bin",
    "/usr/local/cuda/bin",
    "/opt/cuda/bin",
    join(home, ".local", "bin"),
    join(home, "bin"),
    join(home, ".cargo", "bin"),
    ...nvmNodeDirectories(home),
  ];
  if (platform === "darwin") {
    directories.push("/opt/homebrew/bin", "/opt/local/bin");
  }
  return [...new Set(directories.map((directory) => resolve(directory)))];
}
