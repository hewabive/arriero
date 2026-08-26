import {
  CHAT_UI_REPOSITORY_URL,
  ENVIRONMENT_DEFAULT_PYTHON_VERSION,
  ENVIRONMENT_ENGINE_LABELS,
  packageIndexInstallOptions,
  WEBAPP_KINDS,
  webappDescriptor,
  webappEnvironmentCreateInput,
  environmentInstallChannel,
  type EnvironmentRecord,
  type Webapp,
  type WebappKind,
} from "@arriero/core";
import {
  Badge,
  Button,
  Code,
  Group,
  Loader,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

import {
  cancelEnvironmentJob,
  createEnvironment,
  deleteEnvironment,
  getEnvironmentJobLogs,
  getEnvironmentRepositorySettings,
  getEnvironmentSourceRefs,
  getSystemResources,
  listEnvironmentIndexVersions,
  listEnvironmentJobs,
  rebuildEnvironment,
} from "../../api/client";
import {
  substringOptionsFilter,
  TouchAutocomplete,
} from "../components/TouchCombobox";
import { useInvalidateWebapps } from "../components/use-webapp-actions";
import { notifyError } from "../utils/notify";
import { backgroundJobStatusColor } from "../utils/job-status";
import { countLabel } from "../utils/plural";
import { formatLocalDateTime } from "../utils/time";
import { buildStepColor } from "./build-view-helpers";

const WEBAPP_ENGINES = new Set(
  WEBAPP_KINDS.map((entry) => webappDescriptor(entry).environmentEngine),
);

export function WebappsInstallView({
  environments,
  webapps,
  onAddWebapp,
}: {
  environments: EnvironmentRecord[];
  webapps: Webapp[];
  onAddWebapp: () => void;
}) {
  const queryClient = useQueryClient();
  const invalidateWebapps = useInvalidateWebapps();
  const [kind, setKind] = useState<WebappKind>("open-webui");
  const [version, setVersion] = useState(
    webappDescriptor("open-webui").defaultInstallVersion,
  );
  const [showPreReleases, setShowPreReleases] = useState(false);

  const descriptor = webappDescriptor(kind);
  const channel = environmentInstallChannel(descriptor.environmentEngine);

  const systemQuery = useQuery({
    queryKey: ["system-resources"],
    queryFn: getSystemResources,
    staleTime: 30_000,
  });
  const repositoriesQuery = useQuery({
    queryKey: ["environment-repository-settings"],
    queryFn: getEnvironmentRepositorySettings,
  });
  const jobsQuery = useQuery({
    queryKey: ["environment-jobs"],
    queryFn: () => listEnvironmentJobs(12),
    refetchInterval: 2_000,
  });
  const packageIndexUrl = repositoriesQuery.data?.data.packageIndexUrl ?? null;
  const versionsQuery = useQuery({
    queryKey: [
      "environment-index-versions",
      descriptor.environmentEngine,
      packageIndexUrl,
      ENVIRONMENT_DEFAULT_PYTHON_VERSION,
    ],
    queryFn: () =>
      listEnvironmentIndexVersions(
        descriptor.environmentEngine,
        ENVIRONMENT_DEFAULT_PYTHON_VERSION,
      ),
    enabled: channel === "uv",
    staleTime: 120_000,
  });
  const refsQuery = useQuery({
    queryKey: ["environment-source-refs", descriptor.environmentEngine],
    queryFn: () => getEnvironmentSourceRefs(descriptor.environmentEngine),
    enabled: channel === "node-source",
    staleTime: 120_000,
  });

  const uv = systemQuery.data?.data.tools?.uv;
  const nodeSource = systemQuery.data?.data.tools?.nodeSource;
  const toolAvailable =
    channel === "uv" ? Boolean(uv?.available) : Boolean(nodeSource?.available);

  const lookup = versionsQuery.data?.data;
  const versionOptions = useMemo(
    () =>
      (lookup?.versions ?? [])
        .filter((entry) => showPreReleases || !entry.preRelease)
        .map((entry) => ({ value: entry.version, label: entry.version })),
    [lookup, showPreReleases],
  );

  const refs = refsQuery.data?.data;
  const refOptions = useMemo(
    () =>
      refs
        ? [
            { group: "Tags (releases)", items: refs.tags },
            { group: "Branches", items: refs.branches },
          ]
        : [],
    [refs],
  );

  const runtimeEnvironments = environments.filter((environment) =>
    WEBAPP_ENGINES.has(environment.engine),
  );
  const runtimeEnvironmentIds = new Set(
    runtimeEnvironments.map((environment) => environment.id),
  );
  const allJobs = jobsQuery.data?.data ?? [];
  const anyJobRunning = allJobs.some((job) => job.status === "running");
  const jobs = allJobs.filter((job) =>
    runtimeEnvironmentIds.has(job.environmentId),
  );
  const selectedJob =
    jobs.find((job) => job.status === "running") ?? jobs[0] ?? null;
  const jobLogsQuery = useQuery({
    queryKey: ["environment-job-logs", selectedJob?.id],
    queryFn: () => getEnvironmentJobLogs(selectedJob!.id, 300),
    enabled: Boolean(selectedJob),
    refetchInterval: selectedJob?.status === "running" ? 1_500 : false,
  });

  const usedBy = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const webapp of webapps) {
      map.set(webapp.envSpecId, [
        ...(map.get(webapp.envSpecId) ?? []),
        webapp.name,
      ]);
    }
    return map;
  }, [webapps]);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["environments"] }),
      queryClient.invalidateQueries({ queryKey: ["environment-jobs"] }),
      invalidateWebapps(),
    ]);
  }

  const installMutation = useMutation({
    mutationFn: () =>
      createEnvironment(webappEnvironmentCreateInput(kind, version.trim())),
    onSuccess: async () => {
      await refresh();
      notifications.show({
        title: "Runtime install started",
        message: `${descriptor.displayName} ${version.trim()} — watch the install job panel`,
      });
    },
    onError: notifyError("Install failed"),
  });
  const rebuildMutation = useMutation({
    mutationFn: rebuildEnvironment,
    onSuccess: refresh,
    onError: notifyError("Rebuild failed"),
  });
  const deleteMutation = useMutation({
    mutationFn: deleteEnvironment,
    onSuccess: refresh,
    onError: notifyError("Delete failed"),
  });
  const cancelMutation = useMutation({
    mutationFn: cancelEnvironmentJob,
    onSuccess: refresh,
  });

  function switchKind(next: WebappKind) {
    setKind(next);
    setVersion(webappDescriptor(next).defaultInstallVersion);
  }

  const plannedCommands =
    channel === "uv"
      ? [
          [
            "uv pip install",
            ...packageIndexInstallOptions(packageIndexUrl),
            `open-webui==${version.trim() || "<version>"}`,
          ].join(" "),
        ]
      : [
          `git clone --depth 1 --branch ${version.trim() || "<ref>"} ${refs?.url ?? CHAT_UI_REPOSITORY_URL}`,
          "npm ci --ignore-scripts",
          "patch package.json (mongodb-memory-server becomes a runtime dependency)",
          "npm run build",
          "npm prune --omit=dev",
        ];

  const indexStatus = () => {
    if (channel !== "uv") return null;
    if (versionsQuery.isFetching) {
      return (
        <Group gap="xs">
          <Loader size="xs" />
          <Text size="xs" c="dimmed">
            Reading the index…
          </Text>
        </Group>
      );
    }
    if (versionsQuery.isError) {
      return (
        <Text size="xs" c="red">
          {(versionsQuery.error as Error).message}
        </Text>
      );
    }
    if (!lookup) return null;
    if (lookup.status === "ok") {
      return (
        <Text size="xs" c="dimmed">
          {countLabel(lookup.versions.length, "version")} on {lookup.indexUrl}
        </Text>
      );
    }
    return (
      <Text size="xs" c={lookup.status === "unreachable" ? "red" : "orange"}>
        {lookup.status}: {lookup.message}
      </Text>
    );
  };

  const refsStatus = () => {
    if (channel !== "node-source") return null;
    if (refsQuery.isFetching) {
      return (
        <Group gap="xs">
          <Loader size="xs" />
          <Text size="xs" c="dimmed">
            Reading refs…
          </Text>
        </Group>
      );
    }
    if (refsQuery.isError) {
      return (
        <Text size="xs" c="red">
          {(refsQuery.error as Error).message}
        </Text>
      );
    }
    if (!refs) return null;
    if (refs.status === "ok") {
      return (
        <Text size="xs" c="dimmed">
          {countLabel(refs.tags.length, "tag")} and{" "}
          {countLabel(refs.branches.length, "branch", "branches")} on {refs.url}
        </Text>
      );
    }
    return (
      <Text size="xs" c="red">
        unreachable: {refs.message}
      </Text>
    );
  };

  const canInstall = Boolean(version.trim()) && toolAvailable && !anyJobRunning;

  return (
    <Stack gap="md">
      <Paper withBorder p="md">
        <Group justify="space-between" mb="md">
          <Title order={4}>Install a runtime</Title>
          {channel === "uv" ? (
            <Badge color={uv?.available ? "green" : "red"} variant="light">
              {uv?.available
                ? (uv.version ?? "uv available")
                : (uv?.reason ?? "uv unavailable")}
            </Badge>
          ) : (
            <Badge
              color={nodeSource?.available ? "green" : "red"}
              variant="light"
            >
              {nodeSource?.available
                ? "git + npm available"
                : (nodeSource?.reason ?? "git/npm unavailable")}
            </Badge>
          )}
        </Group>
        <Stack gap="sm">
          <SegmentedControl
            fullWidth
            value={kind}
            onChange={(value) => switchKind(value as WebappKind)}
            data={WEBAPP_KINDS.map((entry) => ({
              value: entry,
              label: webappDescriptor(entry).displayName,
            }))}
          />
          <Group align="flex-end" gap="xs" wrap="nowrap">
            {channel === "uv" ? (
              <TouchAutocomplete
                style={{ flex: 1 }}
                label="Version"
                required
                data={versionOptions}
                filter={substringOptionsFilter}
                limit={40}
                value={version}
                onChange={setVersion}
                placeholder="Pick a release from PyPI"
                description="Pick from the index or type any version; the exact value is verified after install"
              />
            ) : (
              <TouchAutocomplete
                style={{ flex: 1 }}
                label="Git ref"
                required
                data={refOptions}
                value={version}
                onChange={setVersion}
                placeholder="v0.10.0"
                description="Tag or branch of huggingface/chat-ui, built from source; refs older than the 2025 v2 rewrite are not supported"
              />
            )}
            <Button
              variant="light"
              aria-label="Reload versions"
              loading={
                channel === "uv"
                  ? versionsQuery.isFetching
                  : refsQuery.isFetching
              }
              onClick={() =>
                void (channel === "uv"
                  ? versionsQuery.refetch()
                  : refsQuery.refetch())
              }
            >
              <RefreshCw size={16} />
            </Button>
          </Group>
          {indexStatus()}
          {refsStatus()}
          {channel === "uv" && (
            <Switch
              size="xs"
              checked={showPreReleases}
              onChange={(event) =>
                setShowPreReleases(event.currentTarget.checked)
              }
              label="Show pre-releases and dev builds"
            />
          )}
          <Code block>{plannedCommands.join("\n")}</Code>
          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              {anyJobRunning
                ? "Another environment installation is running — wait for it to finish."
                : descriptor.installFootprintNote
                  ? `Note: ${descriptor.installFootprintNote}.`
                  : ""}
            </Text>
            <Button
              disabled={!canInstall}
              loading={installMutation.isPending}
              onClick={() => installMutation.mutate()}
            >
              Install
            </Button>
          </Group>
        </Stack>
      </Paper>

      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <Stack gap="sm">
          <Group justify="space-between">
            <Title order={4}>Installed runtimes</Title>
            <Button size="xs" variant="light" onClick={onAddWebapp}>
              Add web app
            </Button>
          </Group>
          {runtimeEnvironments.map((environment) => {
            const users = usedBy.get(environment.id) ?? [];
            return (
              <Paper key={environment.id} withBorder p="md">
                <Group justify="space-between" align="flex-start">
                  <div>
                    <Group gap="xs">
                      <Text fw={600}>
                        {ENVIRONMENT_ENGINE_LABELS[environment.engine]}{" "}
                        {environment.version}
                      </Text>
                      <Badge
                        color={
                          environment.status === "installed"
                            ? "green"
                            : environment.status === "installing"
                              ? "blue"
                              : environment.status === "failed"
                                ? "red"
                                : "gray"
                        }
                      >
                        {environment.status}
                      </Badge>
                      {users.map((name) => (
                        <Badge key={name} variant="light">
                          used by {name}
                        </Badge>
                      ))}
                    </Group>
                    <Text size="xs" c="dimmed">
                      {environment.createdAt
                        ? formatLocalDateTime(environment.createdAt)
                        : "created at unknown"}
                    </Text>
                    {environment.availabilityReason && (
                      <Text size="xs" c="orange">
                        {environment.availabilityReason}
                      </Text>
                    )}
                    {environment.error && (
                      <Text size="xs" c="red">
                        {environment.error}
                      </Text>
                    )}
                  </div>
                  <Group gap="xs">
                    {environment.status !== "installed" && (
                      <Button
                        size="xs"
                        variant="light"
                        disabled={anyJobRunning}
                        onClick={() => rebuildMutation.mutate(environment.id)}
                      >
                        Rebuild
                      </Button>
                    )}
                    <Tooltip
                      label={`Repoint or delete ${users.join(", ")} first`}
                      disabled={users.length === 0}
                    >
                      <Button
                        size="xs"
                        color="red"
                        variant="subtle"
                        disabled={
                          environment.status === "installing" ||
                          users.length > 0
                        }
                        onClick={() => deleteMutation.mutate(environment.id)}
                      >
                        Delete
                      </Button>
                    </Tooltip>
                  </Group>
                </Group>
              </Paper>
            );
          })}
          {runtimeEnvironments.length === 0 && (
            <Text c="dimmed">
              No web app runtimes installed yet — install one above.
            </Text>
          )}
        </Stack>

        <Paper withBorder p="md">
          <Group justify="space-between" mb="xs">
            <Title order={4}>Install job</Title>
            <Group gap="xs">
              <Badge
                color={
                  selectedJob
                    ? backgroundJobStatusColor(selectedJob.status)
                    : "gray"
                }
                variant="light"
              >
                {selectedJob?.status ?? "idle"}
              </Badge>
              {selectedJob?.status === "running" && (
                <Button
                  size="xs"
                  color="red"
                  variant="light"
                  onClick={() => cancelMutation.mutate(selectedJob.id)}
                >
                  Cancel
                </Button>
              )}
            </Group>
          </Group>
          {selectedJob && (
            <Group gap={4} mb="xs">
              {selectedJob.steps.map((step) => (
                <Badge
                  key={step.name}
                  color={buildStepColor(step.status)}
                  variant="outline"
                >
                  {step.name}
                </Badge>
              ))}
            </Group>
          )}
          <Code
            block
            style={{ whiteSpace: "pre-wrap", maxHeight: 460, overflow: "auto" }}
          >
            {(jobLogsQuery.data?.data.lines ?? ["No install job yet."]).join(
              "\n",
            )}
          </Code>
        </Paper>
      </SimpleGrid>
    </Stack>
  );
}
