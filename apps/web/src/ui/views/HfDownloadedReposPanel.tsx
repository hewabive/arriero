import {
  HF_UPDATE_CHECK_MAX_DIRS,
  type HfDownloadedRepo,
  type HfUpdateCheckStatus,
} from "@arriero/core";
import {
  Badge,
  Button,
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
  ChevronDown,
  ChevronRight,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import {
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
  const [deleteTarget, setDeleteTarget] = useState<HfDownloadedRepo | null>(
    null,
  );
  const [expandedFiles, setExpandedFiles] = useState<ReadonlySet<string>>(
    new Set(),
  );

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
    mutationFn: (dir: string) => deleteHfDownload(dir),
    onSuccess: () => {
      setDeleteTarget(null);
      void invalidateDownloads();
      void queryClient.invalidateQueries({ queryKey: ["models"] });
      notifications.show({
        title: "Download deleted",
        message: "The repository directory was removed.",
      });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Delete download",
        message: (error as Error).message,
      }),
  });

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
                        return (
                          <Badge
                            key={variant.paths[0]}
                            color={missing ? "orange" : "green"}
                            variant="light"
                          >
                            {hfVariantChipLabel(variant)} ·{" "}
                            {formatBytes(variant.totalBytes)}
                          </Badge>
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
                  <Button
                    variant="subtle"
                    color="red"
                    size="xs"
                    leftSection={<Trash2 size={14} />}
                    disabled={running}
                    onClick={() => setDeleteTarget(repo)}
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
        title="Delete downloaded repository"
      >
        <Stack gap="sm">
          <Text size="sm">
            Delete <Code>{deleteTarget?.dir}</Code> with{" "}
            {countLabel(deleteTarget?.fileCount ?? 0, "file")} (
            {formatBytes(deleteTarget?.totalBytes ?? 0)})? This removes the
            files from disk.
          </Text>
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              color="red"
              loading={deleteMutation.isPending}
              onClick={() => {
                const target = deleteTarget;
                if (target) {
                  deleteMutation.mutate(target.dir);
                }
              }}
            >
              Delete
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Paper>
  );
}
