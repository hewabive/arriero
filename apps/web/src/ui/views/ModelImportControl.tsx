import {
  parseSplitInfo,
  splitShardName,
  type GgufModel,
  type SafetensorsModel,
} from "@arriero/core";
import { Button, Tooltip } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { FolderCheck, FolderInput } from "lucide-react";
import { useState } from "react";
import { listHfDownloads } from "../../api/hf";
import { getActiveNodeId } from "../../api/base";
import { ModelImportDialog } from "./ModelImportDialog";

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
  const safetensors = "weightFiles" in model;
  const split = safetensors ? null : parseSplitInfo(model.name);
  const paths = safetensors
    ? model.weightFiles.map((file) => `${model.path}/${file}`)
    : split
      ? Array.from(
          { length: split.count },
          (_, index) =>
            `${model.directory}/${splitShardName(split, index + 1, split.count)}`,
        )
      : [model.path];
  const managed =
    paths.length > 0 &&
    downloads.data?.data.some((repo) =>
      paths.every((path) =>
        repo.files.some(
          (file) => file.present && `${repo.dir}/${file.path}` === path,
        ),
      ),
    );
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
          disabled={downloads.isPending || Boolean(managed)}
        >
          {managed ? "Managed" : "Organize"}
        </Button>
      </Tooltip>
      {opened && (
        <ModelImportDialog
          key={`${getActiveNodeId()}:${model.path}`}
          model={model}
          onClose={() => setOpened(false)}
        />
      )}
    </>
  );
}
