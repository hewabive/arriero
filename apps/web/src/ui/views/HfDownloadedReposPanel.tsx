import { HF_UPDATE_CHECK_MAX_DIRS, type HfDownloadedRepo } from "@arriero/core";
import {
  Badge,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Download, RefreshCw } from "lucide-react";
import { useState } from "react";

import {
  checkHfUpdates,
  listHfDownloads,
  startHfDownload,
} from "../../api/client";
import { hfVariantChipLabel } from "../utils/hf";
import { formatBytes } from "../utils/models";
import {
  hfRepoMetaLines,
  hfRepoStatusBadges,
  type HfRepoJobState,
} from "./HfBadges";
import { HfRepoDetailModal } from "./HfRepoDetailModal";
import { hfRepoJobStateForDir, useHfQueueQuery } from "./use-hf-queue";

function repoDiskBytes(repo: HfDownloadedRepo): number {
  return repo.files.reduce(
    (sum, file) => sum + (file.present ? file.size : file.partialBytes),
    0,
  );
}

function HfRepoCard(props: {
  repo: HfDownloadedRepo;
  jobState: HfRepoJobState;
  resuming: boolean;
  onResume: () => void;
  onOpen: () => void;
}) {
  const { repo } = props;
  const presentPaths = new Set(
    repo.files.filter((file) => file.present).map((file) => file.path),
  );
  const diskBytes = repoDiskBytes(repo);
  const missingBytes = Math.max(0, repo.totalBytes - diskBytes);
  const resumable =
    props.jobState === null && missingBytes > 0 && repo.missingFiles > 0;
  return (
    <Paper withBorder p="sm" radius="sm">
      <Group justify="space-between" align="center" wrap="nowrap" gap="sm">
        <UnstyledButton
          className="hf-repo-card"
          onClick={props.onOpen}
          style={{ flex: "1 1 auto", minWidth: 0 }}
        >
          <Stack gap={4}>
            <Group gap="xs" wrap="wrap">
              <Text fw={600} size="sm">
                {repo.repoId}
              </Text>
              {hfRepoStatusBadges(repo, props.jobState)}
              {missingBytes > 0 && (
                <Badge color="orange" variant="light">
                  {formatBytes(missingBytes)} to resume
                </Badge>
              )}
            </Group>
            {repo.variants && repo.variants.length > 0 && (
              <Group gap={6} wrap="wrap">
                {repo.variants.map((variant) => {
                  const missing = variant.paths.some(
                    (path) => !presentPaths.has(path),
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
            {missingBytes > 0 && (
              <Text size="xs" c="dimmed">
                {formatBytes(diskBytes)} of {formatBytes(repo.totalBytes)} on
                disk
              </Text>
            )}
            {hfRepoMetaLines(repo)}
          </Stack>
        </UnstyledButton>
        <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
          {resumable && (
            <Button
              size="xs"
              variant="light"
              leftSection={<Download size={14} />}
              loading={props.resuming}
              onClick={props.onResume}
            >
              Resume · {formatBytes(missingBytes)}
            </Button>
          )}
          <ChevronRight
            size={16}
            style={{ color: "var(--mantine-color-dimmed)" }}
          />
        </Group>
      </Group>
    </Paper>
  );
}

export function HfDownloadedReposPanel() {
  const queryClient = useQueryClient();
  const downloadsQuery = useQuery({
    queryKey: ["hf-downloads"],
    queryFn: listHfDownloads,
  });
  const queueData = useHfQueueQuery().data?.data ?? null;
  const repos = downloadsQuery.data?.data ?? [];
  const [detailDir, setDetailDir] = useState<string | null>(null);
  const detailRepo = repos.find((repo) => repo.dir === detailDir) ?? null;

  const checkMutation = useMutation({
    mutationFn: (dirs: string[]) => checkHfUpdates(dirs),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["hf-downloads"] }),
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Update check",
        message: (error as Error).message,
      }),
  });

  const resumeMutation = useMutation({
    mutationFn: (repo: HfDownloadedRepo) =>
      startHfDownload({
        repoId: repo.repoId,
        revision: repo.revision,
        paths: repo.files
          .filter((file) => !file.present)
          .map((file) => file.path),
        destDir: repo.dir,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["hf-queue"] });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Resume download",
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

        {repos.map((repo) => (
          <HfRepoCard
            key={repo.dir}
            repo={repo}
            jobState={hfRepoJobStateForDir(queueData, repo.dir)}
            resuming={
              resumeMutation.isPending &&
              resumeMutation.variables?.dir === repo.dir
            }
            onResume={() => resumeMutation.mutate(repo)}
            onOpen={() => setDetailDir(repo.dir)}
          />
        ))}
      </Stack>

      <HfRepoDetailModal repo={detailRepo} onClose={() => setDetailDir(null)} />
    </Paper>
  );
}
