import type { HostPackageManager } from "@arriero/core";
import { readFileSync } from "node:fs";

export type OsRelease = {
  id: string | null;
  idLike: string[];
  prettyName: string | null;
};

export function parseOsRelease(contents: string): OsRelease {
  const values = new Map<string, string>();
  for (const line of contents.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const raw = match[2]!.trim();
    const unquoted =
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw;
    values.set(match[1]!, unquoted);
  }
  const idLike = values.get("ID_LIKE");
  return {
    id: values.get("ID") ?? null,
    idLike: idLike ? idLike.split(/\s+/).filter(Boolean) : [],
    prettyName: values.get("PRETTY_NAME") ?? values.get("NAME") ?? null,
  };
}

export function packageManagerForOsRelease(
  release: OsRelease,
): HostPackageManager {
  const family = [release.id, ...release.idLike].filter(
    (item): item is string => Boolean(item),
  );
  for (const item of family) {
    if (item === "debian" || item === "ubuntu") return "apt";
    if (item === "fedora" || item === "rhel" || item === "centos") return "dnf";
    if (item === "arch") return "pacman";
    if (item === "suse" || item === "opensuse") return "zypper";
    if (item === "alpine") return "apk";
  }
  return "unknown";
}

export function installCommandPrefix(
  manager: HostPackageManager,
): string | null {
  if (manager === "apt") return "sudo apt install -y";
  if (manager === "dnf") return "sudo dnf install -y";
  if (manager === "pacman") return "sudo pacman -S --needed";
  if (manager === "zypper") return "sudo zypper install -y";
  if (manager === "apk") return "sudo apk add";
  return null;
}

let cached: OsRelease | null = null;

export function readOsRelease(): OsRelease {
  if (cached) {
    return cached;
  }
  try {
    cached = parseOsRelease(readFileSync("/etc/os-release", "utf8"));
  } catch {
    cached = { id: null, idLike: [], prettyName: null };
  }
  return cached;
}
