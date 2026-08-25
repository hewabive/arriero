import {
  ENVIRONMENT_ENGINE_LABELS,
  type EnvironmentCreate,
} from "@arriero/core";
import {
  Badge,
  Button,
  Code,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  cancelEnvironmentJob,
  createEnvironment,
  deleteEnvironment,
  getEnvironmentRepositorySettings,
  getEnvironmentJobLogs,
  getSystemResources,
  listEnvironmentJobs,
  listEnvironments,
  rebuildEnvironment,
  updateEnvironmentRepositorySettings,
} from "../../api/client";
import { EnvironmentCreateForm } from "../components/EnvironmentCreateForm";
import { EnvironmentRepositorySettingsForm } from "../components/EnvironmentRepositorySettingsForm";
import { formatLocalDateTime } from "../utils/time";

function statusColor(status: string) {
  if (status === "installed" || status === "succeeded") return "green";
  if (status === "installing" || status === "running") return "blue";
  if (status === "failed") return "red";
  if (status === "canceled") return "orange";
  return "gray";
}

export function EnvironmentsView() {
  const queryClient = useQueryClient();
  const environmentsQuery = useQuery({
    queryKey: ["environments"],
    queryFn: listEnvironments,
    refetchInterval: 2_500,
  });
  const jobsQuery = useQuery({
    queryKey: ["environment-jobs"],
    queryFn: () => listEnvironmentJobs(12),
    refetchInterval: 2_000,
  });
  const repositoriesQuery = useQuery({
    queryKey: ["environment-repository-settings"],
    queryFn: getEnvironmentRepositorySettings,
  });
  const systemQuery = useQuery({
    queryKey: ["system-resources"],
    queryFn: getSystemResources,
    staleTime: 30_000,
  });
  const environments = environmentsQuery.data?.data ?? [];
  const jobs = jobsQuery.data?.data ?? [];
  const selectedJob =
    jobs.find((job) => job.status === "running") ?? jobs[0] ?? null;
  const logsQuery = useQuery({
    queryKey: ["environment-job-logs", selectedJob?.id],
    queryFn: () => getEnvironmentJobLogs(selectedJob!.id, 300),
    enabled: Boolean(selectedJob),
    refetchInterval: selectedJob?.status === "running" ? 1_500 : false,
  });
  const running = jobs.some((job) => job.status === "running");
  const uv = systemQuery.data?.data.tools?.uv;

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["environments"] }),
      queryClient.invalidateQueries({ queryKey: ["environment-jobs"] }),
      queryClient.invalidateQueries({ queryKey: ["path-catalog"] }),
    ]);
  }

  const createMutation = useMutation({
    mutationFn: (input: EnvironmentCreate) => createEnvironment(input),
    onSuccess: async (_result, input) => {
      await refresh();
      notifications.show({
        title: "Environment install started",
        message: `${ENVIRONMENT_ENGINE_LABELS[input.engine]} ${input.version}`,
      });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Install failed",
        message: (error as Error).message,
      }),
  });
  const rebuildMutation = useMutation({
    mutationFn: rebuildEnvironment,
    onSuccess: refresh,
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Rebuild failed",
        message: (error as Error).message,
      }),
  });
  const deleteMutation = useMutation({
    mutationFn: deleteEnvironment,
    onSuccess: refresh,
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Delete failed",
        message: (error as Error).message,
      }),
  });
  const cancelMutation = useMutation({
    mutationFn: cancelEnvironmentJob,
    onSuccess: refresh,
  });
  const repositoriesMutation = useMutation({
    mutationFn: updateEnvironmentRepositorySettings,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["environment-repository-settings"],
      });
      notifications.show({
        title: "Python repositories saved",
        message: "New installs and rebuilds will use the updated site profile.",
      });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Repository settings failed",
        message: (error as Error).message,
      }),
  });

  const repositories = repositoriesQuery.data?.data;

  return (
    <Stack gap="md">
      {repositories && (
        <>
          <EnvironmentRepositorySettingsForm
            key={`${repositories.packageIndexUrl ?? ""}|${repositories.pythonMirrorUrl ?? ""}`}
            settings={repositories}
            running={running}
            saving={repositoriesMutation.isPending}
            onSave={(input) => repositoriesMutation.mutate(input)}
          />
          <EnvironmentCreateForm
            uv={uv}
            repositories={repositories}
            running={running}
            submitting={createMutation.isPending}
            onSubmit={(input) => createMutation.mutate(input)}
          />
        </>
      )}
      {repositoriesQuery.isLoading && (
        <Text c="dimmed">Loading Python repository settings…</Text>
      )}
      {repositoriesQuery.isError && (
        <Text c="red">{(repositoriesQuery.error as Error).message}</Text>
      )}

      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <Stack gap="sm">
          {environments.map((environment) => (
            <Paper key={environment.id} withBorder p="md">
              <Group justify="space-between" align="flex-start">
                <div>
                  <Group gap="xs">
                    <Text fw={600}>
                      {ENVIRONMENT_ENGINE_LABELS[environment.engine]}{" "}
                      {environment.version}
                    </Text>
                    <Badge>{environment.variant}</Badge>
                    <Badge color={statusColor(environment.status)}>
                      {environment.status}
                    </Badge>
                    <Badge
                      color={
                        environment.availability === "usable"
                          ? "green"
                          : environment.availability === "unavailable"
                            ? "red"
                            : "gray"
                      }
                    >
                      {environment.availability}
                    </Badge>
                  </Group>
                  <Text size="xs" c="dimmed">
                    {environment.engine === "chat-ui"
                      ? "Node source build"
                      : `Python ${environment.pythonVersion}`}
                    {environment.createdAt
                      ? ` · ${formatLocalDateTime(environment.createdAt)}`
                      : ""}
                  </Text>
                  {environment.availabilityReason && (
                    <Text c="orange" size="xs">
                      {environment.availabilityReason}
                    </Text>
                  )}
                </div>
                <Group gap="xs">
                  {environment.status !== "installed" && (
                    <Button
                      size="xs"
                      variant="light"
                      disabled={running}
                      onClick={() => rebuildMutation.mutate(environment.id)}
                    >
                      Rebuild
                    </Button>
                  )}
                  <Button
                    size="xs"
                    color="red"
                    variant="subtle"
                    disabled={environment.status === "installing"}
                    onClick={() => deleteMutation.mutate(environment.id)}
                  >
                    Delete
                  </Button>
                </Group>
              </Group>
              <Code block mt="sm">
                {environment.entrypoint}
              </Code>
              {environment.error && (
                <Text c="red" size="xs" mt="xs">
                  {environment.error}
                </Text>
              )}
            </Paper>
          ))}
          {environments.length === 0 && (
            <Text c="dimmed">No managed Python environments.</Text>
          )}
        </Stack>
        <Paper withBorder p="md">
          <Group justify="space-between" mb="xs">
            <Text fw={600}>Environment job log</Text>
            <Group gap="xs">
              <Badge color={statusColor(selectedJob?.status ?? "idle")}>
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
          <Code
            block
            style={{ whiteSpace: "pre-wrap", maxHeight: 520, overflow: "auto" }}
          >
            {(logsQuery.data?.data.lines ?? ["No job selected."]).join("\n")}
          </Code>
        </Paper>
      </SimpleGrid>
    </Stack>
  );
}
