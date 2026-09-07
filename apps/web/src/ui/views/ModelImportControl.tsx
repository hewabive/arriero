import {
  parseSplitInfo,
  splitShardName,
  type GgufModel,
  type SafetensorsModel,
} from "@arriero/core";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  Progress,
  ScrollArea,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderCheck, FolderInput } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  commitModelImport,
  getModelImport,
  listHfDownloads,
  prepareModelImport,
} from "../../api/hf";
import { formatBytes } from "../utils/models";

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
          {managed ? "Managed" : "Import"}
        </Button>
      </Tooltip>
      {opened && (
        <ModelImportDialog model={model} onClose={() => setOpened(false)} />
      )}
    </>
  );
}

function ModelImportDialog({
  model,
  onClose,
}: {
  model: GgufModel | SafetensorsModel;
  onClose: () => void;
}) {
  const safetensors = "weightFiles" in model;
  const split = !safetensors && parseSplitInfo(model.name);
  const [directory, setDirectory] = useState(safetensors);
  const [repo, setRepo] = useState(
    !safetensors ? (model.metadata.repoUrl ?? "") : "",
  );
  const [revision, setRevision] = useState("main");
  const [remotePath, setRemotePath] = useState("");
  const [id, setId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const notified = useRef(false);
  const job = useQuery({
    queryKey: ["model-import", id],
    queryFn: () => getModelImport(id!),
    enabled: id !== null,
    refetchInterval: (query) =>
      ["checking", "importing"].includes(
        query.state.data?.data.status ?? "checking",
      )
        ? 1000
        : false,
  });
  const state = job.data?.data;
  const busy = state?.status === "checking" || state?.status === "importing";
  const prepare = useMutation({
    mutationFn: () =>
      prepareModelImport({
        sourcePath: safetensors
          ? model.path
          : directory
            ? model.directory
            : model.path,
        scope: directory ? "directory" : "gguf",
        repo,
        revision,
        remotePath,
      }),
    onSuccess: ({ data }) => {
      queryClient.setQueryData(["model-import", data.id], { data });
      setId(data.id);
    },
    onError: (error) =>
      notifications.show({ color: "red", message: error.message }),
  });
  const commit = useMutation({
    mutationFn: () => commitModelImport(id!),
    onSuccess: ({ data }) =>
      queryClient.setQueryData(["model-import", data.id], { data }),
    onError: (error) =>
      notifications.show({ color: "red", message: error.message }),
  });
  useEffect(() => {
    if (state?.status !== "succeeded" || notified.current) return;
    notified.current = true;
    for (const key of [
      "models",
      "hf-downloads",
      "instances",
      "presets",
      "hf-requirements",
    ])
      void queryClient.invalidateQueries({ queryKey: [key] });
  }, [state?.status, queryClient]);
  const reset = () => {
    setId(null);
    notified.current = false;
  };
  return (
    <Modal
      opened
      onClose={onClose}
      title="Import local model"
      size="xl"
      closeOnClickOutside={!busy}
      closeOnEscape={!busy}
      withCloseButton={!busy}
    >
      <Stack gap="sm">
        <Text size="sm" className="text-wrap">
          {model.path}
        </Text>
        <Text size="sm" c="dimmed">
          Verify local files against a Hugging Face repository, review their
          destination, then import without downloading weights. Existing
          instance paths are updated automatically.
        </Text>
        {!safetensors && split && (
          <Checkbox
            label="Move the entire containing directory, including companion files"
            checked={directory}
            disabled={busy}
            onChange={(event) => {
              setDirectory(event.currentTarget.checked);
              reset();
            }}
          />
        )}
        <Alert color="blue">
          {directory
            ? "The entire directory contents will move. Local companion files absent from the repository are preserved without source verification."
            : split
              ? "All GGUF shards move together. Other files in the directory stay in place."
              : "Only this GGUF file moves. Other files in the directory stay in place."}
        </Alert>
        <TextInput
          label="Hugging Face repository"
          placeholder="owner/repo or repository URL"
          value={repo}
          disabled={busy}
          onChange={(event) => {
            setRepo(event.currentTarget.value);
            reset();
          }}
        />
        <Group grow>
          <TextInput
            label="Revision"
            value={revision}
            disabled={busy}
            onChange={(event) => {
              setRevision(event.currentTarget.value);
              reset();
            }}
          />
          <TextInput
            label={
              directory
                ? "Repository subdirectory (optional)"
                : "Repository file path (optional)"
            }
            description={
              directory
                ? "Leave empty if the folder corresponds to the repository root"
                : "Leave empty to find matching content within this repository"
            }
            value={remotePath}
            disabled={busy}
            onChange={(event) => {
              setRemotePath(event.currentTarget.value);
              reset();
            }}
          />
        </Group>
        {(state?.error || job.error) && (
          <Alert color="red">{state?.error ?? job.error?.message}</Alert>
        )}
        {state?.warnings.map((warning) => (
          <Alert key={warning} color="yellow">
            {warning}
          </Alert>
        ))}
        {busy && (
          <>
            <Text size="sm">
              {state.status === "checking"
                ? "Verifying files"
                : "Importing files"}
              : {state.completed}/{state.total}
            </Text>
            <Progress
              value={state.total ? (state.completed / state.total) * 100 : 0}
              animated
            />
            <Text size="xs" className="text-wrap">
              {state.currentFile}
            </Text>
          </>
        )}
        {state && ["ready", "succeeded"].includes(state.status) && (
          <>
            <Text size="sm" className="text-wrap">
              Destination: {state.destDir}
            </Text>
            <Text size="xs" c="dimmed">
              Verified revision: {state.revision}
            </Text>
            <ScrollArea.Autosize mah={300}>
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Destination file</Table.Th>
                    <Table.Th>Size</Table.Th>
                    <Table.Th>Source</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {state.files.map((file) => (
                    <Table.Tr key={file.source}>
                      <Table.Td>
                        <Text size="xs" className="text-wrap">
                          {file.destination}
                        </Text>
                      </Table.Td>
                      <Table.Td>{formatBytes(file.size)}</Table.Td>
                      <Table.Td>
                        <Badge color={file.verified ? "green" : "gray"}>
                          {file.verified ? "Verified" : "Local"}
                        </Badge>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea.Autosize>
          </>
        )}
        {state?.status === "succeeded" && (
          <Alert color="green">
            Model imported. The model library is being refreshed.
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="subtle" onClick={onClose} disabled={busy}>
            {state?.status === "succeeded" ? "Done" : "Cancel"}
          </Button>
          {state?.status === "ready" ? (
            <Button loading={commit.isPending} onClick={() => commit.mutate()}>
              Move and register
            </Button>
          ) : (
            state?.status !== "succeeded" && (
              <Button
                disabled={!repo.trim() || busy}
                loading={prepare.isPending || state?.status === "checking"}
                onClick={() => prepare.mutate()}
              >
                Verify source
              </Button>
            )
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
