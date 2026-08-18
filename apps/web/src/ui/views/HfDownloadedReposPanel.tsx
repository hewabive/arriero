import {
  HF_UPDATE_CHECK_MAX_DIRS,
  HfDownloadDeleteBlockedSchema,
  type HfDownloadDelete,
  type HfDownloadedRepo,
  type HfUpdateCheckStatus,
} from "@arriero/core";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  Collapse,
  Group,
  Modal,
  Paper,
  Stack,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import {
  ApiError,
  checkHfUpdates,
  deleteHfDownload,
  listHfDownloadJobs,
  listHfDownloads,
  startHfDownload,
} from "../../api/client";
import { hfVariantChipLabel } from "../utils/hf";
import { formatBytes } from "../utils/models";
import { countLabel } from "../utils/plural";
import { formatLocalDateTime } from "../utils/time";

const UPDATE_BADGE_COLOR: Record<HfUpdateCheckStatus, string> = {
  unchecked: "gray",
  "in-sync": "green",
  drift: "yellow",
  error: "red",
};

const EMPTY_SELECTION: ReadonlySet<string> = new Set();

type DeleteTarget = {
  repo: HfDownloadedRepo;
  paths: string[] | null;
};

function deleteTargetBytes(target: DeleteTarget): number {
  if (!target.paths) {
    return target.repo.totalBytes;
  }
  const paths = new Set(target.paths);
  return target.repo.files
    .filter((file) => paths.has(file.path))
    .reduce((sum, file) => sum + file.size, 0);
}

function updateBadge(repo: HfDownloadedRepo) {
  const status = repo.update.status;
  const changed = repo.update.files.filter(
    (file) => file.status !== "current",
  ).length;
  const label =
    status === "drift" && changed > 0 ? `drift · ${changed}` : status;
  const badge = (
    <Badge color={UPDATE_BADGE_COLOR[status]} variant="light">
      {label}
    </Badge>
  );
  if (status === "error" && repo.update.error) {
    return <Tooltip label={repo.update.error}>{badge}</Tooltip>;
  }
  return badge;
}

export function HfDownloadedReposPanel(props: {
  onAddFiles: (repo: HfDownloadedRepo) => void;
}) {
  const queryClient = useQueryClient();
  const downloadsQuery = useQuery({
    queryKey: ["hf-downloads"],
    queryFn: listHfDownloads,
  });
  const jobsQuery = useQuery({
    queryKey: ["hf-download-jobs"],
    queryFn: listHfDownloadJobs,
  });
  const repos = downloadsQuery.data?.data ?? [];
  const runningRepoIds = new Set(
    (jobsQuery.data?.data ?? [])
      .filter((job) => job.status === "running")
      .map((job) => job.repoId),
  );
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [verifyUpstream, setVerifyUpstream] = useState(true);
  const [expandedFiles, setExpandedFiles] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [selectedFiles, setSelectedFiles] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(new Map());

  function toggleFiles(dir: string) {
    setExpandedFiles((previous) => {
      const next = new Set(previous);
      if (next.has(dir)) {
        next.delete(dir);
      } else {
        next.add(dir);
      }
      return next;
    });
  }

  function toggleFileSelection(dir: string, path: string) {
    setSelectedFiles((previous) => {
      const current = new Set(previous.get(dir) ?? []);
      if (current.has(path)) {
        current.delete(path);
      } else {
        current.add(path);
      }
      const next = new Map(previous);
      if (current.size === 0) {
        next.delete(dir);
      } else {
        next.set(dir, current);
      }
      return next;
    });
  }

  function toggleVariantSelection(dir: string, paths: readonly string[]) {
    setSelectedFiles((previous) => {
      const current = new Set(previous.get(dir) ?? []);
      const allSelected = paths.every((path) => current.has(path));
      for (const path of paths) {
        if (allSelected) {
          current.delete(path);
        } else {
          current.add(path);
        }
      }
      const next = new Map(previous);
      if (current.size === 0) {
        next.delete(dir);
      } else {
        next.set(dir, current);
      }
      return next;
    });
    setExpandedFiles((previous) => new Set(previous).add(dir));
  }

  const invalidateDownloads = () =>
    queryClient.invalidateQueries({ queryKey: ["hf-downloads"] });

  const checkMutation = useMutation({
    mutationFn: (dirs: string[]) => checkHfUpdates(dirs),
    onSuccess: () => void invalidateDownloads(),
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Update check",
        message: (error as Error).message,
      }),
  });

  const updatesMutation = useMutation({
    mutationFn: (repo: HfDownloadedRepo) =>
      startHfDownload({
        repoId: repo.repoId,
        revision: repo.update.revisionSha ?? "main",
        paths: repo.update.files
          .filter((file) => file.status === "updated")
          .map((file) => file.path),
        destDir: repo.dir,
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["hf-download-jobs"] });
      notifications.show({
        title: "Download started",
        message: `${result.data.repoId}: ${countLabel(result.data.files.length, "updated file")}`,
      });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Download updates",
        message: (error as Error).message,
      }),
  });

  const deleteMutation = useMutation({
    mutationFn: (input: HfDownloadDelete) => deleteHfDownload(input),
    onSuccess: (_result, input) => {
      setDeleteTarget(null);
      setSelectedFiles((previous) => {
        const next = new Map(previous);
        next.delete(input.dir);
        return next;
      });
      void invalidateDownloads();
      void queryClient.invalidateQueries({ queryKey: ["models"] });
      notifications.show({
        title: input.paths ? "Files deleted" : "Download deleted",
        message: input.paths
          ? `${countLabel(input.paths.length, "file")} removed from disk.`
          : "The repository directory was removed.",
      });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 412) {
        return;
      }
      notifications.show({
        color: "red",
        title: "Delete download",
        message: (error as Error).message,
      });
    },
  });

  function openDeleteModal(repo: HfDownloadedRepo, paths: string[] | null) {
    deleteMutation.reset();
    setVerifyUpstream(true);
    setDeleteTarget({ repo, paths });
  }

  const verifyError =
    deleteMutation.error instanceof ApiError &&
    deleteMutation.error.status === 412
      ? deleteMutation.error
      : null;
  const verifyBlockedParsed = verifyError
    ? HfDownloadDeleteBlockedSchema.safeParse(verifyError.body)
    : null;
  const blockedFiles = verifyBlockedParsed?.success
    ? verifyBlockedParsed.data.verification.files.filter(
        (file) =>
          file.status === "deleted" &&
          (deleteTarget?.paths?.includes(file.path) ?? true),
      )
    : [];

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <Group justify="space-between" wrap="wrap">
          <Title order={4}>Downloaded repositories</Title>
          <Button
            variant="default"
            size="xs"
            leftSection={<RefreshCw size={14} />}
            loading={checkMutation.isPending}
            disabled={repos.length === 0}
            onClick={() =>
              checkMutation.mutate(
                repos
                  .slice(0, HF_UPDATE_CHECK_MAX_DIRS)
                  .map((repo) => repo.dir),
              )
            }
          >
            Check all
          </Button>
        </Group>

        {repos.length === 0 && (
          <Text size="sm" c="dimmed">
            Nothing downloaded yet. Downloads land under the models directory
            and are tracked by a manifest file next to the model files.
          </Text>
        )}

        {repos.map((repo) => {
          const updatedCount = repo.update.files.filter(
            (file) => file.status === "updated",
          ).length;
          const running = runningRepoIds.has(repo.repoId);
          const filesOpened = expandedFiles.has(repo.dir);
          const selected = selectedFiles.get(repo.dir) ?? EMPTY_SELECTION;
          const updateStatusByPath = new Map(
            repo.update.files.map((file) => [file.path, file.status]),
          );
          return (
            <Paper key={repo.dir} withBorder p="sm" radius="sm">
              <Group justify="space-between" align="flex-start" wrap="wrap">
                <Stack gap={4} style={{ flex: "1 1 auto", minWidth: 0 }}>
                  <Group gap="xs" wrap="wrap">
                    <Text fw={600} size="sm">
                      {repo.repoId}
                    </Text>
                    <Badge color="gray" variant="outline">
                      {repo.revision.slice(0, 10)}
                    </Badge>
                    {updateBadge(repo)}
                    {repo.missingFiles > 0 && (
                      <Badge color="orange" variant="light">
                        {countLabel(repo.missingFiles, "missing file")}
                      </Badge>
                    )}
                  </Group>
                  {repo.variants && repo.variants.length > 0 && (
                    <Group gap={6} wrap="wrap">
                      {repo.variants.map((variant) => {
                        const missing = variant.paths.some(
                          (path) =>
                            repo.files.find((file) => file.path === path)
                              ?.present !== true,
                        );
                        const variantSelected = variant.paths.every((path) =>
                          selected.has(path),
                        );
                        return (
                          <Tooltip
                            key={variant.paths[0]}
                            label={
                              variantSelected
                                ? "Deselect these files"
                                : "Select these files for deletion"
                            }
                          >
                            <Badge
                              color={
                                variantSelected
                                  ? "red"
                                  : missing
                                    ? "orange"
                                    : "green"
                              }
                              variant={variantSelected ? "filled" : "light"}
                              component="button"
                              type="button"
                              style={{ cursor: "pointer" }}
                              onClick={() =>
                                toggleVariantSelection(repo.dir, variant.paths)
                              }
                            >
                              {hfVariantChipLabel(variant)} ·{" "}
                              {formatBytes(variant.totalBytes)}
                            </Badge>
                          </Tooltip>
                        );
                      })}
                    </Group>
                  )}
                  <Text
                    size="xs"
                    c="dimmed"
                    style={{ overflowWrap: "anywhere" }}
                  >
                    <Code>{repo.dir}</Code>
                  </Text>
                  <Group gap={4} wrap="wrap">
                    <Button
                      variant="subtle"
                      size="compact-xs"
                      color="gray"
                      leftSection={
                        filesOpened ? (
                          <ChevronDown size={12} />
                        ) : (
                          <ChevronRight size={12} />
                        )
                      }
                      onClick={() => toggleFiles(repo.dir)}
                    >
                      {countLabel(repo.fileCount, "file")}
                    </Button>
                    <Text size="xs" c="dimmed">
                      {formatBytes(repo.totalBytes)} · downloaded{" "}
                      {formatLocalDateTime(repo.downloadedAt)}
                      {repo.update.checkedAt
                        ? ` · checked ${formatLocalDateTime(repo.update.checkedAt)}`
                        : ""}
                    </Text>
                  </Group>
                  <Collapse in={filesOpened}>
                    <Stack gap={2} pl="xs">
                      {repo.files.map((file) => {
                        const upstream = updateStatusByPath.get(file.path);
                        return (
                          <Group key={file.path} gap="xs" wrap="nowrap">
                            <Checkbox
                              size="xs"
                              checked={selected.has(file.path)}
                              onChange={() =>
                                toggleFileSelection(repo.dir, file.path)
                              }
                              aria-label={`Select ${file.path} for deletion`}
                            />
                            <Text
                              size="xs"
                              style={{
                                overflowWrap: "anywhere",
                                flex: "1 1 auto",
                              }}
                            >
                              {file.path}
                            </Text>
                            {!file.present && (
                              <Badge color="orange" variant="light">
                                missing
                              </Badge>
                            )}
                            {upstream === "updated" && (
                              <Badge color="yellow" variant="light">
                                updated upstream
                              </Badge>
                            )}
                            {upstream === "deleted" && (
                              <Badge color="gray" variant="light">
                                deleted upstream
                              </Badge>
                            )}
                            <Text size="xs" c="dimmed">
                              {formatBytes(file.size)}
                            </Text>
                          </Group>
                        );
                      })}
                    </Stack>
                  </Collapse>
                </Stack>
                <Group gap="xs" wrap="wrap">
                  <Button
                    variant="default"
                    size="xs"
                    leftSection={<Plus size={14} />}
                    onClick={() => props.onAddFiles(repo)}
                  >
                    Add files
                  </Button>
                  <Button
                    variant="default"
                    size="xs"
                    loading={
                      checkMutation.isPending &&
                      checkMutation.variables?.length === 1 &&
                      checkMutation.variables[0] === repo.dir
                    }
                    onClick={() => checkMutation.mutate([repo.dir])}
                  >
                    Check
                  </Button>
                  {repo.update.status === "drift" && updatedCount > 0 && (
                    <Button
                      size="xs"
                      loading={updatesMutation.isPending}
                      disabled={running}
                      onClick={() => updatesMutation.mutate(repo)}
                    >
                      Download updates
                    </Button>
                  )}
                  {selected.size > 0 && (
                    <Button
                      variant="light"
                      color="red"
                      size="xs"
                      leftSection={<Trash2 size={14} />}
                      disabled={running}
                      onClick={() =>
                        openDeleteModal(repo, [...selected].sort())
                      }
                    >
                      Delete {countLabel(selected.size, "file")}
                    </Button>
                  )}
                  <Button
                    variant="subtle"
                    color="red"
                    size="xs"
                    leftSection={<Trash2 size={14} />}
                    disabled={running}
                    onClick={() => openDeleteModal(repo, null)}
                  >
                    Delete
                  </Button>
                </Group>
              </Group>
            </Paper>
          );
        })}
      </Stack>

      <Modal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={
          deleteTarget?.paths
            ? "Delete downloaded files"
            : "Delete downloaded repository"
        }
      >
        <Stack gap="sm">
          {deleteTarget?.paths ? (
            <>
              <Text size="sm">
                Delete {countLabel(deleteTarget.paths.length, "file")} (
                {formatBytes(deleteTargetBytes(deleteTarget))}) from{" "}
                <Code>{deleteTarget.repo.repoId}</Code>? This removes the files
                from disk; the rest of the download stays.
              </Text>
              <Stack gap={2} mah={140} style={{ overflowY: "auto" }}>
                {deleteTarget.paths.map((path) => (
                  <Text
                    key={path}
                    size="xs"
                    style={{ overflowWrap: "anywhere" }}
                  >
                    {path}
                  </Text>
                ))}
              </Stack>
              {deleteTarget.paths.length === deleteTarget.repo.fileCount && (
                <Text size="sm" c="orange">
                  Every file is selected, so the whole repository directory will
                  be removed.
                </Text>
              )}
            </>
          ) : (
            <Text size="sm">
              Delete <Code>{deleteTarget?.repo.dir}</Code> with{" "}
              {countLabel(deleteTarget?.repo.fileCount ?? 0, "file")} (
              {formatBytes(deleteTarget?.repo.totalBytes ?? 0)})? This removes
              the files from disk.
            </Text>
          )}
          {verifyError ? (
            <Alert color="yellow" icon={<AlertTriangle size={16} />}>
              <Stack gap={4}>
                <Text size="sm">{verifyError.message}</Text>
                {blockedFiles.map((file) => (
                  <Text
                    key={file.path}
                    size="xs"
                    style={{ overflowWrap: "anywhere" }}
                  >
                    {file.path}
                  </Text>
                ))}
              </Stack>
            </Alert>
          ) : (
            <Checkbox
              checked={verifyUpstream}
              onChange={(event) =>
                setVerifyUpstream(event.currentTarget.checked)
              }
              label="Verify on Hugging Face before deleting"
              description="Blocks deletion when a file is no longer available upstream and could not be re-downloaded."
            />
          )}
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              color="red"
              loading={deleteMutation.isPending}
              onClick={() => {
                const target = deleteTarget;
                if (!target) {
                  return;
                }
                deleteMutation.mutate({
                  dir: target.repo.dir,
                  ...(target.paths ? { paths: target.paths } : {}),
                  verifyUpstream: verifyError ? false : verifyUpstream,
                });
              }}
            >
              {verifyError ? "Delete anyway" : "Delete"}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Paper>
  );
}
