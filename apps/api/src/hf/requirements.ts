import {
  ModelRequirementSchema,
  isHfCommitSha,
  type HfDownloadedRepo,
  type ModelRequirement,
  type ModelRequirementStatus,
} from "@arriero/core";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { config } from "../config.js";
import { createJsonFileStore } from "../config-store/file-store.js";
import { logger } from "../logger.js";
import { newId } from "../utils/id.js";
import { compareStrings } from "../utils/sort.js";
import { listHfDownloads } from "./downloads.js";
import { defaultHfDestDir } from "./paths.js";

export const MODEL_REQUIREMENTS_FILE = resolve(config.configDir, "models.json");

const store = createJsonFileStore<ModelRequirement[]>({
  id: "model-requirements",
  path: MODEL_REQUIREMENTS_FILE,
  schema: z.array(ModelRequirementSchema),
  missing: () => [],
  portablePaths: true,
  cache: "process",
});

function load(): ModelRequirement[] {
  return store.read();
}

function persist(requirements: ModelRequirement[]) {
  const sorted = [...requirements].sort(
    (left, right) =>
      compareStrings(left.repoId, right.repoId) ||
      compareStrings(left.id, right.id),
  );
  store.write(sorted);
}

export function rewriteModelRequirementsFile(): void {
  persist(load());
}

function normalizedDestDir(
  repoId: string,
  destDir: string | null | undefined,
): string | null {
  if (!destDir) {
    return null;
  }
  const resolved = resolve(destDir);
  return resolved === resolve(defaultHfDestDir(repoId)) ? null : resolved;
}

function requirementDestDir(requirement: ModelRequirement): string {
  return resolve(requirement.destDir ?? defaultHfDestDir(requirement.repoId));
}

export function listModelRequirements(): ModelRequirement[] {
  return [...load()];
}

export function upsertModelRequirement(input: {
  repoId: string;
  revision: string;
  paths: string[];
  destDir: string | null;
}): ModelRequirement {
  const destDir = normalizedDestDir(input.repoId, input.destDir);
  const requirements = load();
  const existing = requirements.find(
    (item) => item.repoId === input.repoId && item.destDir === destDir,
  );
  if (existing) {
    const paths = [...new Set([...existing.paths, ...input.paths])].sort();
    const next = ModelRequirementSchema.parse({
      ...existing,
      revision: input.revision,
      paths,
    });
    if (isDeepStrictEqual(existing, next)) {
      return existing;
    }
    persist(
      requirements.map((item) => (item.id === existing.id ? next : item)),
    );
    return next;
  }
  const created = ModelRequirementSchema.parse({
    id: newId(),
    repoId: input.repoId,
    revision: input.revision,
    paths: [...new Set(input.paths)].sort(),
    destDir,
  });
  persist([...requirements, created]);
  return created;
}

export function deleteModelRequirement(id: string): boolean {
  const requirements = load();
  const next = requirements.filter((item) => item.id !== id);
  if (next.length === requirements.length) {
    return false;
  }
  persist(next);
  return true;
}

export function captureModelRequirement(job: {
  repoId: string;
  revision: string;
  destDir: string;
  files: { path: string }[];
}): void {
  if (job.files.length === 0) {
    return;
  }
  try {
    upsertModelRequirement({
      repoId: job.repoId,
      revision: job.revision,
      paths: job.files.map((file) => file.path),
      destDir: job.destDir,
    });
  } catch (error) {
    logger.warn(
      { error, repoId: job.repoId },
      "model requirement capture failed",
    );
  }
}

export function removeModelRequirementForDeletedDownload(
  dir: string,
  paths: string[] | null,
): void {
  const resolvedDir = resolve(dir);
  const requirements = load();
  const matched = requirements.find(
    (item) => requirementDestDir(item) === resolvedDir,
  );
  if (!matched) {
    return;
  }
  if (paths === null) {
    persist(requirements.filter((item) => item.id !== matched.id));
    return;
  }
  const removed = new Set(paths);
  const remaining = matched.paths.filter((path) => !removed.has(path));
  if (remaining.length === matched.paths.length) {
    return;
  }
  if (remaining.length === 0) {
    persist(requirements.filter((item) => item.id !== matched.id));
    return;
  }
  persist(
    requirements.map((item) =>
      item.id === matched.id ? { ...item, paths: remaining } : item,
    ),
  );
}

export function evaluateModelRequirement(
  requirement: ModelRequirement,
  repos: HfDownloadedRepo[],
): ModelRequirementStatus {
  const destDir = requirementDestDir(requirement);
  const repo =
    repos.find((item) => resolve(item.dir) === destDir) ??
    repos.find((item) => item.repoId === requirement.repoId) ??
    null;
  if (!repo) {
    return {
      requirement,
      state: "missing",
      matchedDir: null,
      missingPaths: [...requirement.paths],
      revisionMatch: null,
    };
  }
  const presentPaths = new Set(
    repo.files.filter((file) => file.present).map((file) => file.path),
  );
  const missingPaths = requirement.paths.filter(
    (path) => !presentPaths.has(path),
  );
  const revisionMatch =
    isHfCommitSha(requirement.revision) && isHfCommitSha(repo.revision)
      ? requirement.revision.toLowerCase() === repo.revision.toLowerCase()
      : null;
  return {
    requirement,
    state:
      missingPaths.length === 0
        ? "satisfied"
        : missingPaths.length === requirement.paths.length
          ? "missing"
          : "partial",
    matchedDir: repo.dir,
    missingPaths,
    revisionMatch,
  };
}

export async function listModelRequirementStatuses(): Promise<
  ModelRequirementStatus[]
> {
  const repos = await listHfDownloads();
  return listModelRequirements().map((requirement) =>
    evaluateModelRequirement(requirement, repos),
  );
}
