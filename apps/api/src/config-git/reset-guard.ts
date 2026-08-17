import { classifyConfigGitPath, type ConfigGitFileStatus } from "@arriero/core";

export type ResetProcessRequirement =
  | { scope: "all-processes" }
  | { scope: "deleted-instances"; instanceIds: string[] }
  | { scope: "none" };

const DELETED_ON_RESET_INDEX = new Set(["A", "R", "C", "?"]);
const RENAME_SEPARATOR = " -> ";

function touchedPaths(file: ConfigGitFileStatus): string[] {
  const arrow = file.path.indexOf(RENAME_SEPARATOR);
  if (arrow === -1) return [file.path];
  return [
    file.path.slice(0, arrow),
    file.path.slice(arrow + RENAME_SEPARATOR.length),
  ];
}

function deletedPath(file: ConfigGitFileStatus): string | null {
  if (!DELETED_ON_RESET_INDEX.has(file.index)) return null;
  return touchedPaths(file).at(-1) ?? null;
}

function instanceName(path: string): string | null {
  if (classifyConfigGitPath(path) !== "instance") return null;
  return path.slice("instances/".length, -".json".length);
}

export function resetProcessRequirement(
  files: ConfigGitFileStatus[],
  includeUntracked: boolean,
  activeInstanceIds: readonly string[],
): ResetProcessRequirement {
  const affected = files.filter(
    (file) => includeUntracked || file.index !== "?",
  );
  const touchesSettings = affected.some((file) =>
    touchedPaths(file).some(
      (path) => classifyConfigGitPath(path) === "settings",
    ),
  );
  if (touchesSettings) {
    return { scope: "all-processes" };
  }
  const deletedInstances = new Set(
    affected.flatMap((file) => {
      const path = deletedPath(file);
      const name = path === null ? null : instanceName(path);
      return name === null ? [] : [name];
    }),
  );
  const blocked = activeInstanceIds.filter((id) => deletedInstances.has(id));
  if (blocked.length > 0) {
    return { scope: "deleted-instances", instanceIds: blocked };
  }
  return { scope: "none" };
}
