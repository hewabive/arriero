import type { EnvironmentCreate } from "@arriero/core";
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
  getEnvironmentJobLogs,
  getSystemResources,
  listEnvironmentJobs,
  listEnvironments,
  rebuildEnvironment,
} from "../../api/client";
import { EnvironmentCreateForm } from "../components/EnvironmentCreateForm";
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
        message: `${input.engine === "vllm" ? "vLLM" : "KTransformers"} ${input.version}`,
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

  return (
    <Stack gap="md">
      <EnvironmentCreateForm
        uv={uv}
        running={running}
        submitting={createMutation.isPending}
        onSubmit={(input) => createMutation.mutate(input)}
      />

      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <Stack gap="sm">
          {environments.map((environment) => (
            <Paper key={environment.id} withBorder p="md">
              <Group justify="space-between" align="flex-start">
                <div>
                  <Group gap="xs">
                    <Text fw={600}>
                      {environment.engine === "vllm" ? "vLLM" : "KTransformers"}{" "}
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
                    Python {environment.pythonVersion} ·{" "}
                    {environment.pythonProvisioning} ·{" "}
                    {formatLocalDateTime(environment.createdAt)}
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
