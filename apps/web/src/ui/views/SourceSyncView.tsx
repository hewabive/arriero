import type {
  EngineHelpSourceSync,
  SourceRepositoryOperationJob,
  SourceRepositoryStatus,
  SourceSyncReport,
  SourceSyncSection,
} from "@arriero/core";
import { LLAMA_CPP_SOURCE_ID } from "@arriero/core";
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Code,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  DownloadCloud,
  Pencil,
  RefreshCw,
  Save,
  XCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

import {
  cloneSourceRepository,
  getLlamaArgumentHelpDiff,
  getSourceRepositoryDrift,
  listEngineHelpSources,
  listSourceRepositories,
  pullSourceRepository,
  updateSourceRepositorySettings,
} from "../../api/client";
import { LazyDiff } from "../components/LazyDiff";
import { formatLocalDateTime } from "../utils/time";
import { countLabel } from "../utils/plural";
import { EngineHelpSourcePanel } from "./EngineHelpSourcePanel";
import { SourceOperationPanel } from "./SourceOperationPanel";
import {
  invalidateSourceQueries,
  sourceOperationQueryKey,
  useSourceRepositoryOperation,
} from "./use-source-repository-operation";
import { notifyError } from "../utils/notify";

function checkStatusColor(status: SourceSyncSection["status"]) {
  if (status === "in-sync") return "green";
  if (status === "drift") return "yellow";
  return "red";
}

function checkStatusLabel(status: SourceSyncSection["status"]) {
  if (status === "in-sync") return "in sync";
  if (status === "drift") return "drift";
  return "error";
}

function repositoryStateColor(state: SourceRepositoryStatus["state"]) {
  if (state === "ready") return "green";
  if (state === "dirty") return "yellow";
  if (state === "busy") return "blue";
  if (state === "missing") return "gray";
  return "red";
}

function repositoryStateLabel(status: SourceRepositoryStatus) {
  if (status.state === "busy") {
    return status.activeOperation ?? "busy";
  }
  if (status.state === "missing") return "not cloned";
  return status.state;
}

function isPullable(repository: SourceRepositoryStatus) {
  return repository.valid && repository.state !== "busy";
}

function SectionCard(props: { section: SourceSyncSection; extra?: ReactNode }) {
  const { section } = props;

  if (section.status === "in-sync") {
    return (
      <Paper withBorder p="sm" radius="sm">
        <Group justify="space-between" wrap="nowrap" gap="sm">
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Text fw={600} size="sm">
              {section.title}
            </Text>
            <Text c="dimmed" size="xs">
              {section.summary}
            </Text>
          </Stack>
          <Badge color="green" variant="light">
            in sync
          </Badge>
        </Group>
        {props.extra}
      </Paper>
    );
  }

  return (
    <Paper withBorder p="md" radius="sm">
      <Group justify="space-between" align="flex-start" wrap="nowrap" mb="xs">
        <Stack gap={2}>
          <Text fw={600}>{section.title}</Text>
          <Text c="dimmed" size="sm">
            {section.description}
          </Text>
        </Stack>
        <Badge color={checkStatusColor(section.status)} variant="light">
          {checkStatusLabel(section.status)}
        </Badge>
      </Group>

      <Text c="dimmed" size="xs" mb="sm">
        Source:{" "}
        <Code style={{ overflowWrap: "anywhere", whiteSpace: "normal" }}>
          {section.sourcePath}
        </Code>
      </Text>

      {section.status === "error" ? (
        <Alert
          color="red"
          variant="light"
          icon={<XCircle size={16} />}
          title={section.summary}
        >
          {section.error}
        </Alert>
      ) : section.divergences.length === 0 ? (
        <Alert
          color="yellow"
          variant="light"
          icon={<AlertTriangle size={16} />}
        >
          {section.summary}
        </Alert>
      ) : (
        <Stack gap="xs">
          <Text size="sm">{section.summary}</Text>
          {section.divergences.map((divergence, index) => (
            <Paper
              key={`${divergence.kind}-${index}`}
              withBorder
              p="xs"
              radius="sm"
            >
              <Group justify="space-between" wrap="nowrap" gap="sm">
                <Code>{divergence.label}</Code>
                <Badge
                  size="sm"
                  variant="light"
                  color={divergence.kind === "unprobed" ? "blue" : "orange"}
                >
                  {divergence.kind}
                </Badge>
              </Group>
              {divergence.detail && (
                <Text c="dimmed" size="xs" mt={4}>
                  {divergence.detail}
                </Text>
              )}
            </Paper>
          ))}
        </Stack>
      )}

      {props.extra}
    </Paper>
  );
}

function DriftReport({ report }: { report: SourceSyncReport }) {
  const driftCheckCount = report.sections.filter(
    (section) => section.status === "drift",
  ).length;
  const errorCount = report.sections.filter(
    (section) => section.status === "error",
  ).length;
  const checkedAt = `Checked ${formatLocalDateTime(report.checkedAt)}${
    report.commit ? ` at ${report.commit.slice(0, 12)}` : ""
  }`;

  return (
    <Stack gap="xs">
      {report.status === "in-sync" ? (
        <Group gap="xs" wrap="wrap">
          <CheckCircle2 size={16} color="var(--mantine-color-green-6)" />
          <Text size="sm">Integration checks are in sync</Text>
          <Text c="dimmed" size="xs">
            {checkedAt}
          </Text>
        </Group>
      ) : (
        <Alert
          color={report.status === "drift" ? "yellow" : "red"}
          variant="light"
          icon={
            report.status === "drift" ? (
              <AlertTriangle size={16} />
            ) : (
              <XCircle size={16} />
            )
          }
          title={
            report.status === "drift"
              ? `${countLabel(driftCheckCount, "integration check")} report drift`
              : report.status === "unavailable"
                ? "Source is unavailable"
                : `${countLabel(errorCount, "source check")} failed`
          }
        >
          {checkedAt}
        </Alert>
      )}
      {report.sections.map((section) => (
        <SectionCard
          key={section.id}
          section={section}
          extra={
            report.sourceId === LLAMA_CPP_SOURCE_ID &&
            section.id === "argument-help" &&
            section.status === "drift" ? (
              <Box mt="sm">
                <LazyDiff
                  queryKey={["llama-arg-help-diff"]}
                  queryFn={getLlamaArgumentHelpDiff}
                />
              </Box>
            ) : null
          }
        />
      ))}
    </Stack>
  );
}

function OriginRow({
  repository,
  busy,
  saving,
  onSave,
}: {
  repository: SourceRepositoryStatus;
  busy: boolean;
  saving: boolean;
  onSave: (originUrl: string, onSaved: () => void) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const cleanDraft = draft.trim();
  const canSave =
    cleanDraft.length > 0 &&
    cleanDraft !== repository.spec.originUrl &&
    !busy &&
    !saving;
  const canEdit = !busy && (repository.state === "missing" || repository.valid);

  if (!editing) {
    return (
      <Group gap={6} wrap="wrap">
        <Text c="dimmed" size="sm">
          Origin
        </Text>
        <Code style={{ overflowWrap: "anywhere", whiteSpace: "normal" }}>
          {repository.spec.originUrl}
        </Code>
        <Tooltip label="Change origin">
          <ActionIcon
            size="sm"
            variant="subtle"
            color="gray"
            aria-label="Change origin"
            disabled={!canEdit}
            onClick={() => {
              setDraft(repository.spec.originUrl);
              setEditing(true);
            }}
          >
            <Pencil size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>
    );
  }

  return (
    <Group align="flex-end" gap="xs" wrap="wrap">
      <TextInput
        label="Origin"
        description={
          repository.exists
            ? "Saving changes the checkout's origin remote."
            : "The repository will be cloned from this URL."
        }
        value={draft}
        disabled={busy && !saving}
        autoFocus
        style={{ flex: "1 1 24rem", minWidth: 0 }}
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
      <Group gap="xs" wrap="nowrap">
        <Button
          size="xs"
          variant="light"
          leftSection={<Save size={14} />}
          loading={saving}
          disabled={!canSave}
          onClick={() => onSave(cleanDraft, () => setEditing(false))}
        >
          Save origin
        </Button>
        <Button
          size="xs"
          variant="subtle"
          color="gray"
          disabled={saving}
          onClick={() => setEditing(false)}
        >
          Cancel
        </Button>
      </Group>
    </Group>
  );
}

function SourceRepositoryPanel({
  repository,
  helpSources,
}: {
  repository: SourceRepositoryStatus;
  helpSources: EngineHelpSourceSync[];
}) {
  const queryClient = useQueryClient();
  const sourceOperation = useSourceRepositoryOperation(repository.spec.id);

  const driftQuery = useQuery({
    queryKey: ["source-repository-drift", repository.spec.id],
    queryFn: () => getSourceRepositoryDrift(repository.spec.id),
    enabled:
      repository.valid &&
      repository.state !== "busy" &&
      repository.driftSupported,
    refetchInterval: 30_000,
  });

  const cloneMutation = useMutation({
    mutationFn: () =>
      cloneSourceRepository(repository.spec.id, { branch: null }),
    onSuccess: (response) => {
      sourceOperation.setJob(response.data);
      notifications.show({
        title: `${repository.displayName} clone started`,
        message: repository.repoPath,
      });
    },
    onError: notifyError("Clone failed"),
  });

  const settingsMutation = useMutation({
    mutationFn: (originUrl: string) =>
      updateSourceRepositorySettings(repository.spec.id, { originUrl }),
    onSuccess: async (response) => {
      await invalidateSourceQueries(queryClient, repository.spec.id);
      notifications.show({
        title: "Origin updated",
        message: response.data.status.spec.originUrl,
      });
    },
    onError: notifyError("Origin update failed"),
  });

  const pullMutation = useMutation({
    mutationFn: () => pullSourceRepository(repository.spec.id),
    onSuccess: (response) => {
      sourceOperation.setJob(response.data);
      notifications.show({
        title: `${repository.displayName} pull started`,
        message: "Progress is shown below.",
      });
    },
    onError: notifyError("Pull failed"),
  });

  const busy =
    repository.state === "busy" ||
    sourceOperation.running ||
    cloneMutation.isPending ||
    settingsMutation.isPending ||
    pullMutation.isPending;

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
          <Stack gap={4} style={{ flex: "1 1 20rem", minWidth: 0 }}>
            <Group gap="xs" wrap="wrap">
              <Text fw={700}>{repository.displayName}</Text>
              <Badge
                color={
                  repository.spec.location.type === "managed" ? "blue" : "gray"
                }
                variant="outline"
              >
                {repository.spec.location.type}
              </Badge>
              <Badge
                color={repositoryStateColor(repository.state)}
                variant="light"
              >
                {repositoryStateLabel(repository)}
              </Badge>
              {repository.dirty && (
                <Badge color="yellow" variant="outline">
                  dirty
                </Badge>
              )}
            </Group>
            <Text c="dimmed" size="sm">
              <Code style={{ overflowWrap: "anywhere", whiteSpace: "normal" }}>
                {repository.repoPath}
              </Code>
            </Text>
          </Stack>
          <Group gap="xs">
            {repository.state === "missing" && (
              <Button
                size="xs"
                leftSection={<DownloadCloud size={14} />}
                loading={cloneMutation.isPending}
                disabled={busy}
                onClick={() => cloneMutation.mutate()}
              >
                Clone
              </Button>
            )}
            {repository.valid && (
              <Button
                size="xs"
                variant="default"
                leftSection={<DownloadCloud size={14} />}
                loading={pullMutation.isPending}
                disabled={busy}
                onClick={() => pullMutation.mutate()}
              >
                Pull
              </Button>
            )}
          </Group>
        </Group>

        {repository.valid && (
          <Group gap="xs" wrap="wrap">
            {repository.tracking === "stable-tag" && (
              <Badge color="teal" variant="light">
                Stable releases
              </Badge>
            )}
            {repository.branch && (
              <Badge color="blue" variant="light">
                {repository.branch}
              </Badge>
            )}
            {repository.currentCommit && (
              <Code>{repository.currentCommit.slice(0, 12)}</Code>
            )}
            {repository.latestTag && (
              <Badge color="grape" variant="light">
                {repository.latestTag}
              </Badge>
            )}
          </Group>
        )}

        <OriginRow
          repository={repository}
          busy={busy}
          saving={settingsMutation.isPending}
          onSave={(originUrl, onSaved) =>
            settingsMutation.mutate(originUrl, { onSuccess: onSaved })
          }
        />

        {repository.remoteUrl && repository.originMatches === false && (
          <Alert
            color="yellow"
            variant="light"
            icon={<AlertTriangle size={16} />}
          >
            Configured origin is{" "}
            <Code style={{ overflowWrap: "anywhere", whiteSpace: "normal" }}>
              {repository.spec.originUrl}
            </Code>
            , but the checkout currently uses{" "}
            <Code style={{ overflowWrap: "anywhere", whiteSpace: "normal" }}>
              {repository.remoteUrl}
            </Code>
            .
          </Alert>
        )}

        {repository.error && (
          <Alert
            color="red"
            variant="light"
            icon={<XCircle size={16} />}
            title={
              repository.state === "missing"
                ? `${repository.displayName} is not cloned`
                : "Source repository is unavailable"
            }
          >
            {repository.error}
          </Alert>
        )}

        {repository.state === "missing" && !repository.error && (
          <Alert
            color="blue"
            variant="light"
            icon={<DownloadCloud size={16} />}
            title={`${repository.displayName} is not cloned`}
          >
            Clone it to{" "}
            {repository.spec.location.type === "managed"
              ? "the managed source directory"
              : "the configured external path"}{" "}
            before running integration drift checks.
          </Alert>
        )}

        <SourceOperationPanel
          job={sourceOperation.job}
          canceling={sourceOperation.cancelMutation.isPending}
          onCancel={() => sourceOperation.cancelMutation.mutate()}
        />

        {repository.valid &&
          repository.state !== "busy" &&
          helpSources.map((row) => (
            <EngineHelpSourcePanel key={row.engineId} sync={row} />
          ))}

        {repository.driftSupported &&
          repository.valid &&
          repository.state !== "busy" && (
            <Box>
              {driftQuery.isLoading && (
                <Group gap="xs">
                  <Loader size="sm" />
                  <Text c="dimmed" size="sm">
                    Checking source drift...
                  </Text>
                </Group>
              )}
              {driftQuery.isError && (
                <Alert color="red" variant="light" icon={<XCircle size={16} />}>
                  {(driftQuery.error as Error).message}
                </Alert>
              )}
              {driftQuery.data?.data && (
                <DriftReport report={driftQuery.data.data} />
              )}
            </Box>
          )}
      </Stack>
    </Paper>
  );
}

export function SourceSyncView() {
  const queryClient = useQueryClient();
  const repositoriesQuery = useQuery({
    queryKey: ["source-repositories"],
    queryFn: listSourceRepositories,
    refetchInterval: 30_000,
  });

  const helpSourcesQuery = useQuery({
    queryKey: ["engine-help-sources"],
    queryFn: listEngineHelpSources,
    retry: false,
    refetchInterval: 120_000,
  });

  const repositories = repositoriesQuery.data?.data ?? [];
  const pullableRepositories = repositories.filter(isPullable);

  const pullAllMutation = useMutation({
    mutationFn: (targets: SourceRepositoryStatus[]) =>
      Promise.all(
        targets.map(
          async (
            repository,
          ): Promise<{
            repository: SourceRepositoryStatus;
            job: SourceRepositoryOperationJob | null;
            error: string | null;
          }> => {
            try {
              const response = await pullSourceRepository(repository.spec.id);
              return { repository, job: response.data, error: null };
            } catch (error) {
              return { repository, job: null, error: (error as Error).message };
            }
          },
        ),
      ),
    onSuccess: async (outcomes) => {
      const started = outcomes.filter((outcome) => outcome.job !== null);
      for (const outcome of started) {
        queryClient.setQueryData(
          sourceOperationQueryKey(outcome.repository.spec.id),
          { data: outcome.job },
        );
      }
      for (const outcome of outcomes) {
        if (outcome.error === null) continue;
        notifications.show({
          color: "red",
          title: `${outcome.repository.displayName} pull failed`,
          message: outcome.error,
        });
      }
      if (started.length > 0) {
        notifications.show({
          title: `Pull started for ${countLabel(started.length, "repository", "repositories")}`,
          message: started
            .map((outcome) => outcome.repository.displayName)
            .join(", "),
        });
      }
      await queryClient.invalidateQueries({
        queryKey: ["source-repositories"],
      });
    },
  });

  const refresh = async () => {
    await Promise.all([
      repositoriesQuery.refetch(),
      helpSourcesQuery.refetch(),
      queryClient.invalidateQueries({
        queryKey: ["source-repository-drift"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["engine-help-source-diff"],
      }),
    ]);
  };

  return (
    <Stack gap="md">
      <Group justify="flex-end" gap="xs">
        <Button
          size="xs"
          leftSection={<DownloadCloud size={14} />}
          loading={pullAllMutation.isPending}
          disabled={pullableRepositories.length === 0}
          onClick={() => pullAllMutation.mutate(pullableRepositories)}
        >
          Pull all
        </Button>
        <Button
          size="xs"
          variant="light"
          leftSection={<RefreshCw size={14} />}
          loading={repositoriesQuery.isFetching || helpSourcesQuery.isFetching}
          onClick={() => void refresh()}
        >
          Refresh
        </Button>
      </Group>

      {repositoriesQuery.isLoading && (
        <Group gap="xs">
          <Loader size="sm" />
          <Text c="dimmed" size="sm">
            Reading source repositories...
          </Text>
        </Group>
      )}

      {repositoriesQuery.isError && (
        <Alert color="red" variant="light" icon={<XCircle size={16} />}>
          {(repositoriesQuery.error as Error).message}
        </Alert>
      )}

      {helpSourcesQuery.isError && (
        <Alert color="red" variant="light" icon={<XCircle size={16} />}>
          Could not read the argument help sources:{" "}
          {(helpSourcesQuery.error as Error).message}
        </Alert>
      )}

      {repositories.map((repository) => (
        <SourceRepositoryPanel
          key={repository.spec.id}
          repository={repository}
          helpSources={(helpSourcesQuery.data?.data ?? []).filter(
            (row) => row.sourceId === repository.spec.id,
          )}
        />
      ))}
    </Stack>
  );
}
