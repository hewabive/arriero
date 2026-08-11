import type {
  EngineHelpSourceSync,
  SourceRepositoryStatus,
  SourceSyncReport,
  SourceSyncSection,
} from "@arriero/core";
import { LLAMA_CPP_SOURCE_ID } from "@arriero/core";
import {
  Alert,
  Badge,
  Box,
  Button,
  Code,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  DownloadCloud,
  RefreshCw,
  Save,
  XCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import {
  cloneSourceRepository,
  getLlamaArgumentHelpDiff,
  getSourceRepositoryDrift,
  listEngineHelpSources,
  listSourceRepositories,
  pullSourceRepository,
  updateSourceRepositorySettings,
} from "../../api/client";
import { formatLocalDateTime } from "../utils/time";
import { countLabel } from "../utils/plural";
import { EngineHelpSourcePanel } from "./EngineHelpSourcePanel";
import { SourceOperationPanel } from "./SourceOperationPanel";
import {
  invalidateSourceQueries,
  useSourceRepositoryOperation,
} from "./use-source-repository-operation";

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

function ArgumentHelpDiff(props: { drift: boolean }) {
  const [open, setOpen] = useState(false);
  const diffQuery = useQuery({
    queryKey: ["llama-arg-help-diff"],
    queryFn: getLlamaArgumentHelpDiff,
    enabled: props.drift && open,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  if (!props.drift) return null;

  return (
    <Stack gap="xs" mt="sm">
      <Button
        size="xs"
        variant="subtle"
        w="fit-content"
        loading={diffQuery.isFetching}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Скрыть diff" : "Показать diff"}
      </Button>
      {open && diffQuery.data?.data.diff && (
        <ScrollArea.Autosize mah={420}>
          <Code block>{diffQuery.data.data.diff}</Code>
        </ScrollArea.Autosize>
      )}
      {open && diffQuery.isError && (
        <Text c="red" size="sm">
          Не удалось получить diff: {(diffQuery.error as Error).message}
        </Text>
      )}
    </Stack>
  );
}

function SectionCard(props: { section: SourceSyncSection; extra?: ReactNode }) {
  const { section } = props;
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
      ) : section.status === "in-sync" ? (
        <Alert color="green" variant="light" icon={<CheckCircle2 size={16} />}>
          {section.summary}
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
  const appearance =
    report.status === "in-sync"
      ? {
          color: "green",
          icon: <CheckCircle2 size={16} />,
          title: "Integration checks are in sync",
        }
      : report.status === "drift"
        ? {
            color: "yellow",
            icon: <AlertTriangle size={16} />,
            title: `${countLabel(driftCheckCount, "integration check")} report drift`,
          }
        : {
            color: "red",
            icon: <XCircle size={16} />,
            title:
              report.status === "unavailable"
                ? "Source is unavailable"
                : `${countLabel(errorCount, "source check")} failed`,
          };

  return (
    <Stack gap="md">
      <Alert
        color={appearance.color}
        variant="light"
        icon={appearance.icon}
        title={appearance.title}
      >
        Checked {formatLocalDateTime(report.checkedAt)}
        {report.commit ? ` at ${report.commit.slice(0, 12)}` : ""}
      </Alert>
      {report.sections.map((section) => (
        <SectionCard
          key={section.id}
          section={section}
          extra={
            report.sourceId === LLAMA_CPP_SOURCE_ID &&
            section.id === "argument-help" ? (
              <ArgumentHelpDiff drift={section.status === "drift"} />
            ) : null
          }
        />
      ))}
    </Stack>
  );
}

function helpSourcesNotCoveredByDriftReport(
  repository: SourceRepositoryStatus,
  rows: EngineHelpSourceSync[],
) {
  if (repository.driftSupported) {
    return [];
  }
  return rows.filter((row) => row.sourceId === repository.spec.id);
}

function SourceRepositoryPanel({
  repository,
  helpSources,
}: {
  repository: SourceRepositoryStatus;
  helpSources: EngineHelpSourceSync[];
}) {
  const queryClient = useQueryClient();
  const [originUrl, setOriginUrl] = useState(repository.spec.originUrl);
  const sourceOperation = useSourceRepositoryOperation(repository.spec.id);

  useEffect(() => {
    setOriginUrl(repository.spec.originUrl);
  }, [repository.spec.originUrl]);

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
      cloneSourceRepository(repository.spec.id, {
        originUrl: originUrl.trim(),
        branch: null,
      }),
    onSuccess: (response) => {
      sourceOperation.setJob(response.data);
      notifications.show({
        title: `${repository.displayName} clone started`,
        message: repository.repoPath,
      });
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        title: "Clone failed",
        message: (error as Error).message,
      });
    },
  });

  const settingsMutation = useMutation({
    mutationFn: () =>
      updateSourceRepositorySettings(repository.spec.id, {
        originUrl: originUrl.trim(),
      }),
    onSuccess: async (response) => {
      setOriginUrl(response.data.status.spec.originUrl);
      await invalidateSourceQueries(queryClient, repository.spec.id);
      notifications.show({
        title: "Origin updated",
        message: response.data.status.spec.originUrl,
      });
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        title: "Origin update failed",
        message: (error as Error).message,
      });
    },
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
    onError: (error) => {
      notifications.show({
        color: "red",
        title: "Pull failed",
        message: (error as Error).message,
      });
    },
  });

  const busy =
    repository.state === "busy" ||
    sourceOperation.running ||
    cloneMutation.isPending ||
    settingsMutation.isPending ||
    pullMutation.isPending;
  const cleanOrigin = originUrl.trim();
  const originChanged = cleanOrigin !== repository.spec.originUrl;
  const canSaveOrigin =
    cleanOrigin.length > 0 &&
    originChanged &&
    (repository.state === "missing" || repository.valid) &&
    !busy;

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Stack gap={2} style={{ flex: "1 1 20rem", minWidth: 0 }}>
            <Text fw={700}>{repository.displayName}</Text>
            <Text c="dimmed" size="sm">
              <Code style={{ overflowWrap: "anywhere", whiteSpace: "normal" }}>
                {repository.repoPath}
              </Code>
            </Text>
          </Stack>
          <Group gap="xs">
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
          </Group>
        </Group>

        {repository.valid && (
          <Group gap="xs" wrap="wrap">
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
            {repository.dirty && (
              <Badge color="yellow" variant="outline">
                dirty
              </Badge>
            )}
          </Group>
        )}

        <TextInput
          label="Origin"
          description={
            repository.exists
              ? "Saving changes the checkout's origin remote."
              : "The repository will be cloned from this URL."
          }
          value={originUrl}
          disabled={busy}
          onChange={(event) => setOriginUrl(event.currentTarget.value)}
        />

        {repository.remoteUrl &&
          repository.originMatches === false &&
          !originChanged && (
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

        <Group justify="flex-end" gap="xs" wrap="wrap">
          <Button
            size="xs"
            variant="light"
            leftSection={<Save size={14} />}
            loading={settingsMutation.isPending}
            disabled={!canSaveOrigin}
            onClick={() => settingsMutation.mutate()}
          >
            Save origin
          </Button>
          {repository.state === "missing" && (
            <Button
              size="xs"
              leftSection={<DownloadCloud size={14} />}
              loading={cloneMutation.isPending}
              disabled={!cleanOrigin || busy}
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
      <Group justify="flex-end">
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

      {repositoriesQuery.data?.data.map((repository) => (
        <SourceRepositoryPanel
          key={repository.spec.id}
          repository={repository}
          helpSources={helpSourcesNotCoveredByDriftReport(
            repository,
            helpSourcesQuery.data?.data ?? [],
          )}
        />
      ))}
    </Stack>
  );
}
