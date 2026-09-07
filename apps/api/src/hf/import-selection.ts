import {
  groupGgufFiles,
  parseSplitInfo,
  splitShardName,
  type ModelImportSelection,
  type ModelImportState,
} from "@arriero/core";
import { basename, dirname, join, relative } from "node:path";
import type { DiscoveredImport } from "./import-discovery.js";
import type { ModelImportPlan } from "./model-import-plan.js";
import { HfDownloadRequestError, sanitizeRepoRelativePath } from "./paths.js";

export function selectImportPlan(
  candidate: DiscoveredImport,
  selection: ModelImportSelection,
  state: ModelImportState,
): ModelImportPlan {
  const chosen = new Set(selection.companions);
  for (const path of chosen)
    if (!candidate.related.some((entry) => entry.file.source === path))
      throw new HfDownloadRequestError(
        `Neighboring file was not verified: ${path}`,
      );
  for (const group of groupGgufFiles(
    candidate.related,
    (entry) => entry.file.source,
  )) {
    if (!group.files.some((entry) => chosen.has(entry.file.source))) continue;
    if (!group.complete)
      throw new HfDownloadRequestError(
        "Neighboring GGUF shards are incomplete",
      );
    group.files.forEach((entry) => chosen.add(entry.file.source));
  }
  const related = candidate.related.filter((entry) =>
    chosen.has(entry.file.source),
  );
  if (related.length !== chosen.size)
    throw new HfDownloadRequestError("Neighboring GGUF shards are incomplete");
  const originals = [
    ...candidate.plan.state.files,
    ...related.map((entry) => entry.file),
  ];
  const destinations = new Set<string>();
  const files = originals.map((file) => {
    const destination = selection.destinations[file.source] ?? file.destination;
    if (
      destination !== file.destination &&
      !file.alternatives?.includes(destination)
    )
      throw new HfDownloadRequestError(
        `Destination was not verified: ${destination}`,
      );
    if (destinations.has(destination))
      throw new HfDownloadRequestError(
        `Two files map to the same destination: ${destination}`,
      );
    destinations.add(destination);
    const companion = related.find(
      (entry) => entry.file.source === file.source,
    );
    return {
      ...file,
      destination,
      keepSource: Boolean(
        companion?.file.kind === "companion" && selection.keepCompanions,
      ),
    };
  });
  for (const file of files) {
    const split = parseSplitInfo(basename(file.destination));
    if (!split) continue;
    for (let index = 1; index <= split.count; index++) {
      const path = join(
        dirname(file.destination),
        splitShardName(split, index, split.count),
      );
      if (!destinations.has(path))
        throw new HfDownloadRequestError(
          `Selection is missing a repository shard: ${path}`,
        );
    }
  }
  const records = [
    ...candidate.plan.manifestFiles,
    ...related.map((entry) => entry.manifest),
  ];
  const manifestFiles = records.map((record) => {
    const source = originals.find(
      (file) =>
        relative(candidate.plan.state.destDir, file.destination) ===
        record.path,
    );
    const selected = files.find((file) => file.source === source?.source);
    if (!selected)
      throw new HfDownloadRequestError(
        `Missing verified mapping for ${record.path}`,
      );
    return {
      ...record,
      path: sanitizeRepoRelativePath(
        relative(candidate.plan.state.destDir, selected.destination),
      ),
    };
  });
  Object.assign(state, {
    sourcePath: candidate.plan.source,
    destDir: candidate.plan.state.destDir,
    repoId: candidate.candidate.repoId,
    revision: candidate.candidate.revision,
    files,
    selectedCandidateId: candidate.candidate.id,
    error: null,
  });
  const warnings = [
    ...new Set([...state.warnings, ...candidate.plan.state.warnings]),
  ];
  state.warnings = warnings;
  return {
    ...candidate.plan,
    files: [
      ...candidate.plan.files,
      ...related.map((entry) => entry.source),
    ].map((file) => ({ ...file })),
    manifestFiles,
    state,
  };
}
