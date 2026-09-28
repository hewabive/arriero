import {
  parseSplitInfo,
  splitShardNames,
  type GgufModel,
  type HfDownloadedRepo,
  type SafetensorsModel,
} from "@arriero/core";
import { Button, Tooltip } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { FolderCheck, FolderInput } from "lucide-react";
import { useState } from "react";
import { listHfDownloads } from "../../api/hf";
import { ModelImportDialog } from "./ModelImportDialog";

type PresentFileRepos = ReadonlyMap<string, ReadonlySet<string>>;

const presentFileReposCache = new WeakMap<
  readonly HfDownloadedRepo[],
  PresentFileRepos
>();

function presentFileRepos(
  repos: readonly HfDownloadedRepo[],
): PresentFileRepos {
  const cached = presentFileReposCache.get(repos);
  if (cached) {
    return cached;
  }
  const index = new Map<string, Set<string>>();
  for (const repo of repos) {
    for (const file of repo.files) {
      if (!file.present) {
        continue;
      }
      const path = `${repo.dir}/${file.path}`;
      const dirs = index.get(path) ?? new Set<string>();
      dirs.add(repo.dir);
      index.set(path, dirs);
    }
  }
  presentFileReposCache.set(repos, index);
  return index;
}

function presentInOneRepo(
  paths: readonly string[],
  repos: readonly HfDownloadedRepo[],
): boolean {
  const index = presentFileRepos(repos);
  const [first, ...rest] = paths;
  const candidates = first === undefined ? undefined : index.get(first);
  return (
    candidates !== undefined &&
    [...candidates].some((dir) =>
      rest.every((path) => index.get(path)?.has(dir) ?? false),
    )
  );
}

function modelFilePaths(model: GgufModel | SafetensorsModel): string[] {
  if ("weightFiles" in model) {
    return model.weightFiles.map((file) => `${model.path}/${file}`);
  }
  const split = parseSplitInfo(model.name);
  return split
    ? splitShardNames(split).map((name) => `${model.directory}/${name}`)
    : [model.path];
}

export function ModelImportControl({
  model,
}: {
  model: GgufModel | SafetensorsModel;
}) {
  const [opened, setOpened] = useState(false);
  const downloads = useQuery({
    queryKey: ["hf-downloads"],
    queryFn: listHfDownloads,
  });
  const managed = downloads.data
    ? presentInOneRepo(modelFilePaths(model), downloads.data.data)
    : false;
  return (
    <>
      <Tooltip
        label={
          managed
            ? "Files are registered in the arriero Hugging Face library"
            : "Verify the Hugging Face source and move into the download directory"
        }
      >
        <Button
          size="xs"
          variant="subtle"
          color={managed ? "green" : "gray"}
          leftSection={
            managed ? <FolderCheck size={14} /> : <FolderInput size={14} />
          }
          onClick={() => setOpened(true)}
          disabled={downloads.isPending || managed}
        >
          {managed ? "Managed" : "Organize"}
        </Button>
      </Tooltip>
      {opened && (
        <ModelImportDialog
          key={model.path}
          model={model}
          onClose={() => setOpened(false)}
        />
      )}
    </>
  );
}
