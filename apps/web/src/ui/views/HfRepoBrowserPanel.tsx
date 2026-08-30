import {
  parseHfRepoInput,
  type HfDownloadQueueJob,
  type HfDownloadedRepo,
  type HfRepoBrowse,
  type HfTreeFile,
} from "@arriero/core";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  Collapse,
  Group,
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Download, Search } from "lucide-react";
import { useMemo, useState } from "react";

import {
  browseHfRepo,
  getHfDestCheck,
  getHfDownloadSettings,
  getModelScanSettings,
  listHfDownloads,
  listPathCatalog,
  startHfDownload,
  updateHfDownloadSettings,
} from "../../api/client";
import { PathPickerInput } from "../components/PathPickerInput";
import { hfLocalFileState, hfLocalVariantState } from "../utils/hf";
import { formatBytes, pathBaseName } from "../utils/models";
import { countLabel } from "../utils/plural";
import { hfFileLocalBadge } from "./HfBadges";
import { HfVariantCheckbox } from "./HfVariantCheckbox";
import { useHfQueueQuery } from "./use-hf-queue";
import { notifyError } from "../utils/notify";

const DEST_CHECK_DEBOUNCE_MS = 350;
const PRIMARY_MODEL_DIRECTORY = "primary";

type DirGroup = { dir: string; files: HfTreeFile[]; totalBytes: number };
type DestinationMode = "model-directory" | "custom";

export function HfRepoBrowserPanel(props: {
  onEnqueued?: ((job: HfDownloadQueueJob) => void) | undefined;
}) {
  const [repoInput, setRepoInput] = useState("");
  const [revisionInput, setRevisionInput] = useState("");
  const [submitted, setSubmitted] = useState<{
    repo: string;
    revision: string;
  } | null>(null);
  const [destDir, setDestDir] = useState("");
  const [resultsOpened, setResultsOpened] = useState(true);

  const browseQuery = useQuery({
    queryKey: ["hf-browse", submitted?.repo ?? "", submitted?.revision ?? ""],
    queryFn: () =>
      browseHfRepo(submitted?.repo ?? "", submitted?.revision || undefined),
    enabled: submitted !== null,
    retry: false,
    staleTime: 60_000,
  });
  const browse: HfRepoBrowse | null = browseQuery.data?.data ?? null;

  function submitBrowse() {
    const parsed = parseHfRepoInput(repoInput);
    if (!parsed) {
      notifications.show({
        color: "red",
        title: "HuggingFace repo",
        message: "Enter a repo id like owner/repo or a huggingface.co URL.",
      });
      return;
    }
    const revision = revisionInput.trim() || parsed.revision || "";
    setRepoInput(parsed.repoId);
    if (!revisionInput.trim() && parsed.revision) {
      setRevisionInput(parsed.revision);
    }
    setSubmitted({ repo: parsed.repoId, revision });
    setResultsOpened(true);
  }

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <Title order={4}>Repository browser</Title>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitBrowse();
          }}
        >
          <Group align="flex-end" gap="sm" wrap="wrap">
            <TextInput
              label="Repository"
              placeholder="owner/repo or huggingface.co URL"
              value={repoInput}
              onChange={(event) => setRepoInput(event.currentTarget.value)}
              w={340}
            />
            <TextInput
              label="Revision"
              placeholder="main"
              value={revisionInput}
              onChange={(event) => setRevisionInput(event.currentTarget.value)}
              w={160}
            />
            <Button
              type="submit"
              leftSection={<Search size={14} />}
              loading={browseQuery.isFetching}
              disabled={repoInput.trim().length === 0}
            >
              Browse
            </Button>
          </Group>
        </form>

        {browseQuery.isError && (
          <Alert color="red" title="Browse failed">
            {(browseQuery.error as Error).message}
          </Alert>
        )}

        {browse && (
          <Stack gap="xs">
            <Group gap={4}>
              <Button
                variant="subtle"
                size="compact-sm"
                color="gray"
                leftSection={
                  resultsOpened ? (
                    <ChevronDown size={14} />
                  ) : (
                    <ChevronRight size={14} />
                  )
                }
                onClick={() => setResultsOpened((value) => !value)}
              >
                {browse.repoId}
              </Button>
              <Text size="xs" c="dimmed">
                {countLabel(browse.files.length, "file")}
              </Text>
            </Group>
            <Collapse expanded={resultsOpened}>
              <BrowseResults
                key={`${browse.repoId}@${browse.commitSha}`}
                browse={browse}
                destDir={destDir}
                onDestDirChange={setDestDir}
                onEnqueued={(job) => {
                  setResultsOpened(false);
                  props.onEnqueued?.(job);
                }}
              />
            </Collapse>
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}

function BrowseResults(props: {
  browse: HfRepoBrowse;
  destDir: string;
  onDestDirChange: (value: string) => void;
  onEnqueued: (job: HfDownloadQueueJob) => void;
}) {
  const { browse, destDir } = props;
  const queryClient = useQueryClient();
  const queueData = useHfQueueQuery().data?.data ?? null;
  const queueAhead =
    (queueData?.active ? 1 : 0) + (queueData?.queued.length ?? 0);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [allFilesOpened, setAllFilesOpened] = useState(
    () => browse.ggufVariants === null,
  );
  const [destinationMode, setDestinationMode] = useState<DestinationMode>(() =>
    destDir.trim() ? "custom" : "model-directory",
  );
  const downloadSettingsQuery = useQuery({
    queryKey: ["hf-download-settings"],
    queryFn: getHfDownloadSettings,
  });
  const modelScanSettingsQuery = useQuery({
    queryKey: ["model-scan-settings"],
    queryFn: getModelScanSettings,
  });
  const modelDirectoriesQuery = useQuery({
    queryKey: ["path-catalog", "models-dir"],
    queryFn: () => listPathCatalog("models-dir"),
  });
  const downloadSettings = downloadSettingsQuery.data?.data ?? null;
  const modelScanSettings = modelScanSettingsQuery.data?.data ?? null;
  const modelDirectories = modelDirectoriesQuery.data?.data ?? [];
  const savedModelDirectoryId = downloadSettings?.modelDirectoryId ?? null;
  const selectedModelDirectoryMissing =
    modelDirectoriesQuery.isSuccess &&
    savedModelDirectoryId !== null &&
    !modelDirectories.some((entry) => entry.id === savedModelDirectoryId);
  const modelDirectoryOptions = useMemo(
    () => [
      {
        value: PRIMARY_MODEL_DIRECTORY,
        label: modelScanSettings
          ? `Primary — ${modelScanSettings.directory}`
          : "Primary models directory",
      },
      ...modelDirectories.map((entry) => ({
        value: entry.id,
        label: `${entry.name} — ${entry.path}`,
      })),
      ...(selectedModelDirectoryMissing && savedModelDirectoryId
        ? [
            {
              value: savedModelDirectoryId,
              label: "Disconnected model directory — using primary",
            },
          ]
        : []),
    ],
    [
      modelDirectories,
      modelScanSettings,
      savedModelDirectoryId,
      selectedModelDirectoryMissing,
    ],
  );
  const customDestDir = destinationMode === "custom" ? destDir.trim() : "";
  const [debouncedDestDir] = useDebouncedValue(
    customDestDir,
    DEST_CHECK_DEBOUNCE_MS,
  );

  const fileByPath = useMemo(() => {
    const map = new Map<string, HfTreeFile>();
    for (const file of browse.files) {
      map.set(file.path, file);
    }
    return map;
  }, [browse]);

  const dirGroups = useMemo((): DirGroup[] => {
    const map = new Map<string, HfTreeFile[]>();
    for (const file of browse.files) {
      const slash = file.path.lastIndexOf("/");
      const dir = slash === -1 ? "" : file.path.slice(0, slash);
      const list = map.get(dir) ?? [];
      list.push(file);
      map.set(dir, list);
    }
    return [...map.entries()]
      .map(([dir, files]) => ({
        dir,
        files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
        totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      }))
      .sort((a, b) => a.dir.localeCompare(b.dir));
  }, [browse]);

  const destQuery = useQuery({
    queryKey: [
      "hf-dest-check",
      browse.repoId,
      destinationMode,
      debouncedDestDir,
      savedModelDirectoryId,
    ],
    queryFn: () =>
      getHfDestCheck(
        debouncedDestDir ? { dir: debouncedDestDir } : { repo: browse.repoId },
      ),
    enabled:
      destinationMode === "model-directory" || debouncedDestDir.length > 0,
  });
  const destCheck = destQuery.data?.data ?? null;

  const downloadsQuery = useQuery({
    queryKey: ["hf-downloads"],
    queryFn: listHfDownloads,
  });
  const localCandidates = (downloadsQuery.data?.data ?? []).filter(
    (repo) => repo.repoId === browse.repoId,
  );
  const localRepo: HfDownloadedRepo | null =
    localCandidates.find((repo) => repo.dir === destCheck?.dir) ??
    localCandidates[0] ??
    null;
  const localFiles = useMemo(
    () => new Map((localRepo?.files ?? []).map((file) => [file.path, file])),
    [localRepo],
  );
  const localPresentCount = (localRepo?.files ?? []).filter(
    (file) => file.present,
  ).length;
  const localOnlyCount = (localRepo?.files ?? []).filter(
    (file) => file.present && !fileByPath.has(file.path),
  ).length;

  const startMutation = useMutation({
    mutationFn: () =>
      startHfDownload({
        repoId: browse.repoId,
        revision: browse.commitSha,
        paths: [...selection],
        ...(customDestDir ? { destDir: customDestDir } : {}),
      }),
    onSuccess: (result) => {
      setSelection(new Set());
      if (destinationMode === "custom") {
        setDestinationMode("model-directory");
        props.onDestDirChange("");
      }
      void queryClient.invalidateQueries({ queryKey: ["hf-queue"] });
      props.onEnqueued(result.data);
    },
    onError: notifyError("Download"),
  });
  const modelDirectoryMutation = useMutation({
    mutationFn: (modelDirectoryId: string | null) => {
      if (!downloadSettings) {
        throw new Error("Download settings are not loaded");
      }
      return updateHfDownloadSettings({
        ...downloadSettings,
        modelDirectoryId,
      });
    },
    onSuccess: (result) => {
      queryClient.setQueryData(["hf-download-settings"], result);
    },
    onError: notifyError("Default model directory"),
  });
  const displayedModelDirectoryId = modelDirectoryMutation.isPending
    ? modelDirectoryMutation.variables
    : savedModelDirectoryId;

  function togglePaths(paths: readonly string[], checked: boolean) {
    setSelection((previous) => {
      const next = new Set(previous);
      for (const path of paths) {
        if (checked) {
          next.add(path);
        } else {
          next.delete(path);
        }
      }
      return next;
    });
  }

  function toggleDir(dir: string) {
    setExpandedDirs((previous) => {
      const next = new Set(previous);
      if (next.has(dir)) {
        next.delete(dir);
      } else {
        next.add(dir);
      }
      return next;
    });
  }

  const selectedBytes = [...selection].reduce(
    (sum, path) => sum + (fileByPath.get(path)?.size ?? 0),
    0,
  );
  const freeBytes = destCheck?.freeBytes ?? null;
  const notEnoughSpace = freeBytes !== null && selectedBytes > freeBytes;

  return (
    <Stack gap="sm">
      <Group gap="xs" wrap="wrap">
        <Code>{browse.repoId}</Code>
        <Badge color="gray" variant="outline">
          {browse.commitSha.slice(0, 10)}
        </Badge>
        {browse.gated && (
          <Badge color="orange" variant="light">
            gated
          </Badge>
        )}
        {browse.private && (
          <Badge color="orange" variant="light">
            private
          </Badge>
        )}
        <Text size="sm" c="dimmed">
          {countLabel(browse.files.length, "file")}
        </Text>
        {browse.truncated && (
          <Badge color="yellow" variant="light">
            listing truncated
          </Badge>
        )}
      </Group>

      {localRepo && (
        <Alert color="blue" variant="light" title="Already downloaded">
          <Group gap="sm" wrap="wrap">
            <Text size="sm" style={{ overflowWrap: "anywhere" }}>
              <Code>{localRepo.dir}</Code> ·{" "}
              {countLabel(localPresentCount, "file")} on disk
              {localOnlyCount > 0
                ? ` · ${countLabel(localOnlyCount, "file")} not in this revision`
                : ""}
            </Text>
            {destCheck && destCheck.dir !== localRepo.dir && (
              <Button
                size="xs"
                variant="default"
                onClick={() => {
                  setDestinationMode("custom");
                  props.onDestDirChange(localRepo.dir);
                }}
              >
                Use this directory
              </Button>
            )}
          </Group>
        </Alert>
      )}

      {browse.ggufVariants && browse.ggufVariants.length > 0 && (
        <Stack gap={6}>
          <Text fw={600} size="sm">
            GGUF variants
          </Text>
          <ScrollArea.Autosize mah={320} type="auto" offsetScrollbars>
            <Stack gap={4}>
              {browse.ggufVariants.map((variant) => (
                <HfVariantCheckbox
                  key={variant.paths[0]}
                  variant={variant}
                  state={hfLocalVariantState(
                    variant.paths,
                    fileByPath,
                    localFiles,
                  )}
                  selection={selection}
                  onToggle={togglePaths}
                />
              ))}
            </Stack>
          </ScrollArea.Autosize>
        </Stack>
      )}

      <Stack gap={6}>
        <Group gap={4}>
          <Button
            variant="subtle"
            size="compact-sm"
            leftSection={
              allFilesOpened ? (
                <ChevronDown size={14} />
              ) : (
                <ChevronRight size={14} />
              )
            }
            onClick={() => setAllFilesOpened((value) => !value)}
          >
            All files
          </Button>
          <Button
            variant="subtle"
            size="compact-sm"
            onClick={() =>
              togglePaths(
                browse.files.map((file) => file.path),
                true,
              )
            }
          >
            Select all
          </Button>
          <Button
            variant="subtle"
            size="compact-sm"
            onClick={() => setSelection(new Set())}
            disabled={selection.size === 0}
          >
            Clear
          </Button>
        </Group>
        <Collapse expanded={allFilesOpened}>
          <ScrollArea.Autosize mah={360} type="auto" offsetScrollbars>
            <Stack gap={2}>
              {dirGroups.map((group) => {
                const paths = group.files.map((file) => file.path);
                const checked = paths.every((path) => selection.has(path));
                const indeterminate =
                  !checked && paths.some((path) => selection.has(path));
                const expanded =
                  expandedDirs.has(group.dir) || group.dir === "";
                return (
                  <Stack key={group.dir || "(root)"} gap={2}>
                    {group.dir !== "" && (
                      <Group gap={6} wrap="nowrap">
                        <Checkbox
                          checked={checked}
                          indeterminate={indeterminate}
                          onChange={(event) =>
                            togglePaths(paths, event.currentTarget.checked)
                          }
                        />
                        <Button
                          variant="subtle"
                          size="compact-sm"
                          color="gray"
                          leftSection={
                            expanded ? (
                              <ChevronDown size={14} />
                            ) : (
                              <ChevronRight size={14} />
                            )
                          }
                          onClick={() => toggleDir(group.dir)}
                        >
                          {group.dir}/
                        </Button>
                        <Text size="xs" c="dimmed">
                          {countLabel(group.files.length, "file")} ·{" "}
                          {formatBytes(group.totalBytes)}
                        </Text>
                      </Group>
                    )}
                    <Collapse expanded={expanded}>
                      <Stack gap={2} pl={group.dir === "" ? 0 : 28}>
                        {group.files.map((file) => (
                          <Checkbox
                            key={file.path}
                            checked={selection.has(file.path)}
                            onChange={(event) =>
                              togglePaths(
                                [file.path],
                                event.currentTarget.checked,
                              )
                            }
                            label={
                              <Group gap="xs" wrap="nowrap">
                                <Text
                                  size="sm"
                                  style={{
                                    overflowWrap: "anywhere",
                                  }}
                                >
                                  {pathBaseName(file.path)}
                                </Text>
                                <Text size="xs" c="dimmed">
                                  {formatBytes(file.size)}
                                </Text>
                                {hfFileLocalBadge(
                                  hfLocalFileState(file, localFiles),
                                )}
                              </Group>
                            }
                          />
                        ))}
                      </Stack>
                    </Collapse>
                  </Stack>
                );
              })}
            </Stack>
          </ScrollArea.Autosize>
        </Collapse>
      </Stack>

      <Stack gap={6}>
        <Text fw={600} size="sm">
          Destination
        </Text>
        <SegmentedControl
          value={destinationMode}
          onChange={(value) => setDestinationMode(value as DestinationMode)}
          data={[
            { value: "model-directory", label: "Model directory" },
            { value: "custom", label: "Custom path" },
          ]}
        />
        <Group align="flex-end" gap="sm" wrap="wrap">
          {destinationMode === "model-directory" ? (
            <Select
              label="Base model directory"
              data={modelDirectoryOptions}
              value={
                modelDirectoriesQuery.isSuccess && displayedModelDirectoryId
                  ? displayedModelDirectoryId
                  : PRIMARY_MODEL_DIRECTORY
              }
              onChange={(value) => {
                if (!value) {
                  return;
                }
                modelDirectoryMutation.mutate(
                  value === PRIMARY_MODEL_DIRECTORY ? null : value,
                );
              }}
              allowDeselect={false}
              searchable
              disabled={
                !downloadSettings ||
                !modelScanSettings ||
                !modelDirectoriesQuery.isSuccess ||
                modelDirectoryMutation.isPending
              }
              w={420}
            />
          ) : (
            <PathPickerInput
              label="Full destination path"
              mode="directory"
              value={destDir}
              onChange={props.onDestDirChange}
              placeholder="Choose a directory for this repository"
              w={420}
              loading={destQuery.isFetching}
            />
          )}
          <Button
            leftSection={<Download size={14} />}
            onClick={() => startMutation.mutate()}
            loading={startMutation.isPending}
            disabled={
              selection.size === 0 ||
              notEnoughSpace ||
              (destinationMode === "custom" && customDestDir.length === 0)
            }
          >
            {queueAhead > 0 ? "Add to queue" : "Download"}
          </Button>
        </Group>
        {destinationMode === "model-directory" ? (
          <Text size="xs" c="dimmed">
            {modelDirectoryMutation.isPending
              ? "Saving the default model directory…"
              : "Saved for future downloads."}
            {destCheck && !modelDirectoryMutation.isPending ? (
              <>
                {" "}
                Repository path: <Code>{destCheck.dir}</Code>
              </>
            ) : null}
          </Text>
        ) : (
          <Text size="xs" c="dimmed">
            {customDestDir
              ? "This path applies only to this download; the saved model directory is unchanged."
              : "Choose the full repository directory for this download."}
          </Text>
        )}
        {selectedModelDirectoryMissing && (
          <Text size="xs" c="orange">
            The saved model directory is no longer connected. The primary models
            directory is being used; choose it above to save the fallback.
          </Text>
        )}
      </Stack>
      <Group gap="xs" wrap="wrap">
        <Text size="sm" c={notEnoughSpace ? "red" : "dimmed"}>
          Selected {countLabel(selection.size, "file")} ·{" "}
          {formatBytes(selectedBytes)}
          {freeBytes !== null ? ` · free ${formatBytes(freeBytes)}` : ""}
        </Text>
        {queueAhead > 0 && (
          <Text size="sm" c="dimmed">
            Will start after {countLabel(queueAhead, "download")} ahead in the
            queue.
          </Text>
        )}
        {destCheck && !destCheck.insideScanRoots && (
          <Text size="sm" c="orange">
            Outside the model scan roots — the download will not appear in the
            list below.
          </Text>
        )}
      </Group>
    </Stack>
  );
}
