import {
  classifyConfigGitPath,
  configGitInstanceName,
  type ConfigGitFileStatus,
} from "@arriero/core";

export type ResetProcessRequirement =
  | { scope: "all-processes" }
  | { scope: "deleted-instances"; instanceIds: string[] }
  | { scope: "none" };

const DELETED_ON_RESET_INDEX = new Set(["A", "R", "C", "?"]);

function touchedPaths(file: ConfigGitFileStatus): string[] {
  return file.origPath === null ? [file.path] : [file.origPath, file.path];
}

function deletedPath(file: ConfigGitFileStatus): string | null {
  return DELETED_ON_RESET_INDEX.has(file.index) ? file.path : null;
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
      const name = path === null ? null : configGitInstanceName(path);
      return name === null ? [] : [name];
    }),
  );
  const blocked = activeInstanceIds.filter((id) => deletedInstances.has(id));
  if (blocked.length > 0) {
    return { scope: "deleted-instances", instanceIds: blocked };
  }
  return { scope: "none" };
}
