import {
  groupGgufFiles,
  type GgufModel,
  type SafetensorsModel,
  type ModelImportSelection,
  type ModelImportState,
} from "@arriero/core";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Collapse,
  Group,
  Modal,
  Paper,
  Progress,
  ScrollArea,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  cancelModelImport,
  commitModelImport,
  getModelImport,
  listModelImports,
  prepareModelImport,
  selectModelImport,
} from "../../api/hf";
import { formatBytes } from "../utils/models";
import { countLabel } from "../utils/plural";

export function ModelImportDialog({
  model,
  onClose,
}: {
  model: GgufModel | SafetensorsModel;
  onClose: () => void;
}) {
  const safetensors = "weightFiles" in model;
  const [directory, setDirectory] = useState(safetensors);
  const [repo, setRepo] = useState("");
  const [revision, setRevision] = useState("main");
  const [remotePath, setRemotePath] = useState("");
  const [refine, setRefine] = useState(false);
  const [keepCompanions, setKeepCompanions] = useState(true);
  const [id, setId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const initialized = useRef(false);
  const notified = useRef(false);
  const history = useQuery({
    queryKey: ["model-imports"],
    queryFn: listModelImports,
    staleTime: 0,
    refetchOnMount: "always",
  });
  const job = useQuery({
    queryKey: ["model-import", id],
    queryFn: () => getModelImport(id!),
    enabled: id !== null,
    retry: false,
    refetchInterval: (query) =>
      ["searching", "checking", "importing"].includes(
        query.state.data?.data.status ?? "checking",
      )
        ? 1000
        : false,
  });
  const state = job.data?.data;
  const busy =
    !job.isError &&
    (state?.status === "searching" ||
      state?.status === "checking" ||
      state?.status === "importing");
  const accept = ({ data }: { data: ModelImportState }) => {
    queryClient.setQueryData(["model-import", data.id], { data });
    setId(data.id);
    void queryClient.invalidateQueries({ queryKey: ["model-imports"] });
  };
  const onError = (error: Error) =>
    notifications.show({ color: "red", message: error.message });
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
    onSuccess: accept,
    onError,
  });
  const selection = useMutation({
    mutationFn: selectModelImport,
    onSuccess: accept,
    onError,
  });
  const commit = useMutation({
    mutationFn: () => commitModelImport(id!),
    onSuccess: accept,
    onError,
  });
  const cancel = useMutation({
    mutationFn: () => cancelModelImport(id!),
    onSuccess: accept,
    onError,
  });
  const controlsBusy =
    busy || prepare.isPending || selection.isPending || commit.isPending;
  useEffect(() => {
    if (!history.data || history.isFetching || initialized.current) return;
    initialized.current = true;
    const previous = history.data.data.find(
      (entry) =>
        entry.sourcePath === model.path ||
        (entry.scope === "directory" &&
          entry.sourcePath === model.directory &&
          entry.candidates.some((candidate) =>
            candidate.files.some((file) => file.source === model.path),
          )),
    );
    if (previous && !["canceled", "succeeded"].includes(previous.status)) {
      setDirectory(previous.scope === "directory");
      const companions = previous.candidates
        .find((entry) => entry.id === previous.selectedCandidateId)
        ?.relatedFiles.filter((file) => file.kind === "companion");
      const selectedCompanions = previous.files.filter((file) =>
        companions?.some((entry) => entry.source === file.source),
      );
      if (selectedCompanions.length)
        setKeepCompanions(selectedCompanions.some((file) => file.keepSource));
      queryClient.setQueryData(["model-import", previous.id], {
        data: previous,
      });
      setId(previous.id);
    } else prepare.mutate();
  }, [
    history.data,
    history.isFetching,
    model.path,
    model.directory,
    queryClient,
    prepare.mutate,
  ]);
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
  const candidate = state?.candidates.find(
    (entry) => entry.id === state.selectedCandidateId,
  );
  const selectedNeighbors =
    candidate?.relatedFiles
      .filter((file) =>
        state?.files.some((entry) => entry.source === file.source),
      )
      .map((file) => file.source) ?? [];
  const choose = (overrides: Partial<ModelImportSelection> = {}) => {
    if (!state) return;
    selection.mutate({
      id: state.id,
      candidateId: state.selectedCandidateId ?? "",
      companions: selectedNeighbors,
      destinations: Object.fromEntries(
        state.files.map((file) => [file.source, file.destination]),
      ),
      keepCompanions,
      ...overrides,
    });
  };
  const restart = () => {
    initialized.current = true;
    notified.current = false;
    prepare.mutate();
  };
  return (
    <Modal opened onClose={onClose} title="Organize model files" size="xl">
      <Stack gap="sm">
        <Text size="sm" className="text-wrap">
          {model.path}
        </Text>
        <Text size="sm" c="dimmed">
          Find matching files on Hugging Face, choose a repository and review
          what to import. Saved instance and preset paths are updated when files
          move.
        </Text>
        {history.isPending && <Text size="sm">Loading previous searches…</Text>}
        {(state?.error || job.error || history.error) && (
          <Alert color="red">
            {state?.error ?? job.error?.message ?? history.error?.message}
          </Alert>
        )}
        {state?.warnings.map((warning) => (
          <Alert key={warning} color="yellow">
            {warning}
          </Alert>
        ))}
        {state?.searchTruncated && (
          <Alert color="yellow">
            Search was limited. More repositories or neighboring files may
            exist. Refine the search to check other candidates.
          </Alert>
        )}
        {busy && (
          <>
            <Text size="sm">
              {state?.status === "importing"
                ? "Importing files"
                : "Searching and verifying content"}
              : {state?.completed}/{state?.total}
            </Text>
            <Progress
              value={state?.total ? (state.completed / state.total) * 100 : 0}
              animated
            />
            <Text size="xs" className="text-wrap">
              {state?.currentFile}
            </Text>
            <Group>
              <Button
                variant="subtle"
                size="xs"
                loading={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                {state?.status === "importing"
                  ? "Cancel import"
                  : "Cancel search"}
              </Button>
              <Text size="xs" c="dimmed">
                You can close this window and reopen it to return to this
                operation.
              </Text>
            </Group>
          </>
        )}
        {!busy &&
          state &&
          state.candidates.length > 0 &&
          state.status !== "succeeded" && (
            <Stack gap="xs">
              <Text fw={600} size="sm">
                {state.candidates.length > 1
                  ? "These repositories contain matching content. Choose where to register your files."
                  : "Matching content found"}
              </Text>
              {state.candidates.map((entry) => (
                <Paper withBorder p="sm" key={entry.id}>
                  <Group justify="space-between" wrap="wrap">
                    <Stack gap={2}>
                      <Text size="sm" fw={600} className="text-wrap">
                        {entry.repoId}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {countLabel(
                          entry.files.filter((file) => file.verified).length,
                          "verified file",
                        )}{" "}
                        ·{" "}
                        {countLabel(
                          entry.relatedFiles.length,
                          "matching neighboring file",
                        )}
                      </Text>
                    </Stack>
                    <Button
                      size="xs"
                      variant={
                        state.selectedCandidateId === entry.id
                          ? "light"
                          : "outline"
                      }
                      disabled={
                        controlsBusy ||
                        !["ready", "choosing"].includes(state.status)
                      }
                      onClick={() =>
                        choose({
                          candidateId: entry.id,
                          companions: [],
                          destinations: {},
                        })
                      }
                    >
                      {state.selectedCandidateId === entry.id
                        ? "Selected"
                        : "Choose"}
                    </Button>
                  </Group>
                </Paper>
              ))}
            </Stack>
          )}
        {state?.status === "ready" &&
          candidate &&
          candidate.relatedFiles.length > 0 && (
            <Stack gap="xs">
              <Group justify="space-between">
                <Text size="sm" fw={600}>
                  Matching files around this model
                </Text>
                <Button
                  size="xs"
                  variant="subtle"
                  disabled={controlsBusy}
                  onClick={() =>
                    choose({
                      companions: [
                        ...new Set([
                          ...selectedNeighbors,
                          ...candidate.relatedFiles
                            .filter((file) => file.kind === "companion")
                            .map((file) => file.source),
                        ]),
                      ],
                    })
                  }
                >
                  Add companion files
                </Button>
              </Group>
              {groupGgufFiles(
                candidate.relatedFiles,
                (file) => file.source,
              ).map(({ files: group }) => {
                const file = group[0]!;
                return (
                  <Checkbox
                    key={file.source}
                    checked={group.every((entry) =>
                      selectedNeighbors.includes(entry.source),
                    )}
                    disabled={controlsBusy}
                    label={`${file.relativePath}${group.length > 1 ? ` (${countLabel(group.length, "shard")})` : ""}`}
                    description={`${file.kind === "companion" ? "Companion" : "Another model variant"} · ${formatBytes(group.reduce((sum, entry) => sum + entry.size, 0))} · content verified`}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      const paths = new Set(group.map((entry) => entry.source));
                      choose({
                        companions: checked
                          ? [...new Set([...selectedNeighbors, ...paths])]
                          : selectedNeighbors.filter(
                              (path) => !paths.has(path),
                            ),
                      });
                    }}
                  />
                );
              })}
              <Checkbox
                label="Keep original companion files available to other models"
                description="Copy selected companion files instead of moving them."
                checked={keepCompanions}
                disabled={controlsBusy}
                onChange={(event) => {
                  const keep = event.currentTarget.checked;
                  setKeepCompanions(keep);
                  choose({ keepCompanions: keep });
                }}
              />
            </Stack>
          )}
        {state && ["ready", "succeeded"].includes(state.status) && (
          <>
            <Text size="sm" className="text-wrap">
              Destination: {state.destDir}
            </Text>
            <Text size="xs" c="dimmed" className="text-wrap">
              Verified revision: {state.revision}
            </Text>
            <ScrollArea.Autosize mah={320}>
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Destination file</Table.Th>
                    <Table.Th>Size</Table.Th>
                    <Table.Th>Action</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {state.files.map((file) => (
                    <Table.Tr key={file.source}>
                      <Table.Td>
                        {state.status === "ready" &&
                        (file.alternatives?.length ?? 0) > 1 ? (
                          <Select
                            aria-label={`Repository path for ${file.source}`}
                            description="Identical content exists at multiple paths"
                            value={file.destination}
                            disabled={controlsBusy}
                            data={file.alternatives!.map((path) => ({
                              value: path,
                              label: path.slice(state.destDir.length + 1),
                            }))}
                            onChange={(destination) => {
                              if (destination)
                                choose({
                                  destinations: {
                                    ...Object.fromEntries(
                                      state.files.map((entry) => [
                                        entry.source,
                                        entry.destination,
                                      ]),
                                    ),
                                    [file.source]: destination,
                                  },
                                });
                            }}
                          />
                        ) : (
                          <Text size="xs" className="text-wrap">
                            {file.destination.slice(state.destDir.length + 1)}
                          </Text>
                        )}
                        {!file.verified && (
                          <Badge color="gray" size="xs">
                            Local companion
                          </Badge>
                        )}
                      </Table.Td>
                      <Table.Td>{formatBytes(file.size)}</Table.Td>
                      <Table.Td>
                        <Text size="xs">
                          {file.source === file.destination
                            ? "Register"
                            : file.keepSource
                              ? "Copy"
                              : "Move"}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea.Autosize>
            {state.blockers.map((blocker) => (
              <Alert key={blocker} color="yellow">
                {blocker}
              </Alert>
            ))}
            {state.status === "ready" && state.blockers.length > 0 && (
              <Button
                variant="light"
                size="xs"
                loading={selection.isPending}
                onClick={() => choose()}
              >
                Recheck availability
              </Button>
            )}
          </>
        )}
        {state?.status === "succeeded" && (
          <Alert color="green">
            Files imported. The model library is being refreshed.
          </Alert>
        )}
        {state?.status === "canceled" && (
          <Alert color="gray">Operation canceled.</Alert>
        )}
        <Button variant="subtle" size="xs" onClick={() => setRefine(!refine)}>
          {refine ? "Hide search options" : "Refine search"}
        </Button>
        <Collapse expanded={refine}>
          <Stack gap="sm">
            <TextInput
              label="Model name or Hugging Face repository (optional)"
              description="Leave empty to search using the filename and model metadata."
              value={repo}
              disabled={controlsBusy}
              onChange={(event) => setRepo(event.currentTarget.value)}
            />
            <Group grow align="start">
              <TextInput
                label="Revision"
                value={revision}
                disabled={controlsBusy}
                onChange={(event) => setRevision(event.currentTarget.value)}
              />
              <TextInput
                label={
                  directory
                    ? "Repository subdirectory (optional)"
                    : "Repository file path (optional)"
                }
                value={remotePath}
                disabled={controlsBusy}
                onChange={(event) => setRemotePath(event.currentTarget.value)}
              />
            </Group>
            {!safetensors && (
              <Checkbox
                label="Import the entire containing folder"
                description="Include all contents of a dedicated model folder."
                checked={directory}
                disabled={controlsBusy}
                onChange={(event) => setDirectory(event.currentTarget.checked)}
              />
            )}
            {directory && (
              <Text size="sm" c="dimmed">
                The whole folder will move, including configuration, tokenizer
                and local companion files.
              </Text>
            )}
            <Button
              variant="light"
              onClick={restart}
              loading={prepare.isPending}
              disabled={controlsBusy}
            >
              Search again
            </Button>
          </Stack>
        </Collapse>
        <Group justify="flex-end">
          <Button variant="subtle" onClick={onClose}>
            {state?.status === "succeeded" ? "Done" : "Close"}
          </Button>
          {state?.status === "ready" && (
            <Button
              disabled={controlsBusy || state.blockers.length > 0}
              loading={commit.isPending}
              onClick={() => commit.mutate()}
            >
              Import {countLabel(state.files.length, "file")}
            </Button>
          )}
          {!busy &&
            (!state || ["failed", "canceled"].includes(state.status)) && (
              <Button onClick={restart} loading={prepare.isPending}>
                Search for matching files
              </Button>
            )}
        </Group>
      </Stack>
    </Modal>
  );
}
