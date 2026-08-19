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
import { ChevronRight, RefreshCw } from "lucide-react";
import { useState } from "react";

import {
  checkHfUpdates,
  listHfDownloadJobs,
  listHfDownloads,
} from "../../api/client";
import { hfVariantChipLabel } from "../utils/hf";
import { formatBytes } from "../utils/models";
import { hfRepoMetaLines, hfRepoStatusBadges } from "./HfBadges";
import { HfRepoDetailModal } from "./HfRepoDetailModal";

function HfRepoCard(props: {
  repo: HfDownloadedRepo;
  running: boolean;
  onOpen: () => void;
}) {
  const { repo } = props;
  const presentPaths = new Set(
    repo.files.filter((file) => file.present).map((file) => file.path),
  );
  return (
    <UnstyledButton className="hf-repo-card" onClick={props.onOpen}>
      <Paper withBorder p="sm" radius="sm">
        <Group justify="space-between" align="center" wrap="nowrap" gap="sm">
          <Stack gap={4} style={{ flex: "1 1 auto", minWidth: 0 }}>
            <Group gap="xs" wrap="wrap">
              <Text fw={600} size="sm">
                {repo.repoId}
              </Text>
              {hfRepoStatusBadges(repo, props.running)}
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
            {hfRepoMetaLines(repo)}
          </Stack>
          <ChevronRight
            size={16}
            style={{ flexShrink: 0, color: "var(--mantine-color-dimmed)" }}
          />
        </Group>
      </Paper>
    </UnstyledButton>
  );
}

export function HfDownloadedReposPanel() {
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
            running={runningRepoIds.has(repo.repoId)}
            onOpen={() => setDetailDir(repo.dir)}
          />
        ))}
      </Stack>

      <HfRepoDetailModal
        repo={detailRepo}
        running={detailRepo !== null && runningRepoIds.has(detailRepo.repoId)}
        onClose={() => setDetailDir(null)}
      />
    </Paper>
  );
}
