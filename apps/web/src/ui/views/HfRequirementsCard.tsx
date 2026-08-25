import type { ModelRequirementStatus } from "@arriero/core";
import {
  ActionIcon,
  Badge,
  Button,
  Code,
  Group,
  Paper,
  Stack,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";

import {
  createModelRequirement,
  deleteModelRequirement,
  listHfDownloads,
  listModelRequirements,
} from "../../api/client";
import { countLabel } from "../utils/plural";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function stateColor(state: ModelRequirementStatus["state"]): string {
  switch (state) {
    case "satisfied":
      return "teal";
    case "partial":
      return "yellow";
    default:
      return "red";
  }
}

function revisionLabel(revision: string): string {
  return SHA_PATTERN.test(revision) ? revision.slice(0, 8) : revision;
}

export function HfRequirementsCard() {
  const queryClient = useQueryClient();
  const statusesQuery = useQuery({
    queryKey: ["hf-requirements"],
    queryFn: listModelRequirements,
    refetchInterval: 15_000,
  });
  const downloadsQuery = useQuery({
    queryKey: ["hf-downloads"],
    queryFn: listHfDownloads,
  });

  const statuses = statusesQuery.data?.data ?? [];
  const repos = downloadsQuery.data?.data ?? [];
  const coveredDirs = new Set(
    statuses.map((status) => status.matchedDir).filter(Boolean),
  );
  const coveredRepoIds = new Set(
    statuses.map((status) => status.requirement.repoId),
  );
  const untracked = repos.filter(
    (repo) => !coveredDirs.has(repo.dir) && !coveredRepoIds.has(repo.repoId),
  );

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["hf-requirements"] });
  }

  const trackMutation = useMutation({
    mutationFn: (repo: (typeof repos)[number]) =>
      createModelRequirement({
        repoId: repo.repoId,
        revision: repo.revision,
        paths: repo.files.map((file) => file.path),
        destDir: repo.dir,
      }),
    onSuccess: invalidate,
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Track requirement failed",
        message: (error as Error).message,
      }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteModelRequirement(id),
    onSuccess: invalidate,
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Delete requirement failed",
        message: (error as Error).message,
      }),
  });

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <Stack gap={2}>
          <Title order={4}>Model requirements</Title>
          <Text size="xs" c="dimmed">
            Tracked in the portable configuration (models.json): which HF
            repositories this configuration needs. Captured automatically when a
            download is enqueued.
          </Text>
        </Stack>

        {statuses.length === 0 && (
          <Text size="sm" c="dimmed">
            No requirements recorded yet.
          </Text>
        )}

        {statuses.map((status) => (
          <Group
            key={status.requirement.id}
            justify="space-between"
            wrap="wrap"
            gap="xs"
          >
            <Group gap="xs" wrap="wrap">
              <Text size="sm" fw={600}>
                {status.requirement.repoId}
              </Text>
              <Code>{revisionLabel(status.requirement.revision)}</Code>
              <Text size="xs" c="dimmed">
                {countLabel(status.requirement.paths.length, "file")}
              </Text>
              {status.requirement.destDir && (
                <Text size="xs" c="dimmed">
                  → {status.requirement.destDir}
                </Text>
              )}
            </Group>
            <Group gap="xs" wrap="nowrap">
              <Tooltip
                label={
                  status.missingPaths.length > 0
                    ? `${countLabel(status.missingPaths.length, "file")} missing on this host`
                    : "All required files are present on this host"
                }
                multiline
                maw={320}
              >
                <Badge color={stateColor(status.state)} variant="light">
                  {status.state}
                </Badge>
              </Tooltip>
              {status.revisionMatch === false && (
                <Tooltip label="The downloaded revision differs from the required one">
                  <Badge color="orange" variant="outline">
                    revision drift
                  </Badge>
                </Tooltip>
              )}
              <ActionIcon
                aria-label="Delete requirement"
                color="red"
                variant="subtle"
                loading={
                  deleteMutation.isPending &&
                  deleteMutation.variables === status.requirement.id
                }
                onClick={() => deleteMutation.mutate(status.requirement.id)}
              >
                <Trash2 size={16} />
              </ActionIcon>
            </Group>
          </Group>
        ))}

        {untracked.length > 0 && (
          <Stack gap={4}>
            <Text size="xs" c="dimmed">
              Downloaded but not tracked as required:
            </Text>
            {untracked.map((repo) => (
              <Group key={repo.dir} justify="space-between" wrap="wrap">
                <Text size="sm">{repo.repoId}</Text>
                <Button
                  size="xs"
                  variant="light"
                  loading={
                    trackMutation.isPending &&
                    trackMutation.variables?.dir === repo.dir
                  }
                  onClick={() => trackMutation.mutate(repo)}
                >
                  Track as required
                </Button>
              </Group>
            ))}
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}
