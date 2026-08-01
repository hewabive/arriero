import type { ExternalLlamaProcess } from "@arriero/core";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Modal,
  Paper,
  Stack,
  Table,
  Text,
  Tooltip,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Power, RefreshCw, ShieldAlert } from "lucide-react";
import { useState } from "react";

import {
  killExternalLlamaProcess,
  listExternalLlamaProcesses,
} from "../../api/client";

type KillIntent = {
  process: ExternalLlamaProcess;
  force: boolean;
};

function managedBadge(processInfo: ExternalLlamaProcess) {
  if (processInfo.managedInstanceId) {
    return (
      <Badge color="blue" variant="light">
        {processInfo.managedRunStatus ?? "managed"}
      </Badge>
    );
  }
  return (
    <Badge color="orange" variant="light">
      external
    </Badge>
  );
}

function killLabel(force: boolean) {
  return force ? "Force kill" : "Terminate";
}

function ProcessActions(props: {
  process: ExternalLlamaProcess;
  onKill: (intent: KillIntent) => void;
}) {
  const managed = Boolean(props.process.managedInstanceId);
  return (
    <Group gap={4} justify="flex-end" wrap="nowrap">
      <Tooltip
        label={
          managed
            ? "Use instance controls for this process"
            : "Send SIGTERM to this external llama-server"
        }
      >
        <ActionIcon
          aria-label="Terminate external llama-server"
          variant="subtle"
          color="yellow"
          disabled={managed}
          onClick={() => props.onKill({ process: props.process, force: false })}
        >
          <Power size={16} />
        </ActionIcon>
      </Tooltip>
      <Tooltip
        label={
          managed
            ? "Use instance controls for this process"
            : "Send SIGKILL to this external llama-server"
        }
      >
        <ActionIcon
          aria-label="Force kill external llama-server"
          variant="subtle"
          color="red"
          disabled={managed}
          onClick={() => props.onKill({ process: props.process, force: true })}
        >
          <ShieldAlert size={16} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}

export function ProcessesView() {
  const queryClient = useQueryClient();
  const [killIntent, setKillIntent] = useState<KillIntent | null>(null);
  const processesQuery = useQuery({
    queryKey: ["external-llama-processes"],
    queryFn: listExternalLlamaProcesses,
    refetchInterval: 4_000,
  });

  const result = processesQuery.data?.data;
  const processes = result?.processes ?? [];

  const killMutation = useMutation({
    mutationFn: (intent: KillIntent) =>
      killExternalLlamaProcess(intent.process.pid, intent.force),
    onSuccess: async (result) => {
      setKillIntent(null);
      await queryClient.invalidateQueries({
        queryKey: ["external-llama-processes"],
      });
      await queryClient.invalidateQueries({
        queryKey: ["instances-health-summary"],
      });
      notifications.show({
        title: "Signal sent",
        message: `${result.data.signal} -> pid ${result.data.pid}`,
      });
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        title: "Kill failed",
        message: (error as Error).message,
      });
    },
  });

  return (
    <>
      <Paper withBorder p="md" radius="sm">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start">
            <div className="section-heading">
              <Title order={4}>llama-server processes</Title>
              <Text c="dimmed" size="sm">
                Processes detected from the operating system process table
              </Text>
            </div>
            <Button
              variant="light"
              leftSection={<RefreshCw size={16} />}
              loading={processesQuery.isFetching}
              onClick={() => void processesQuery.refetch()}
            >
              Refresh
            </Button>
          </Group>

          {result?.unsupported && (
            <Alert color="red" icon={<AlertTriangle size={16} />}>
              {result.error ?? "Process discovery is unsupported"}
            </Alert>
          )}

          <Stack className="processes-mobile-list" gap="xs">
            {processes.map((processInfo) => (
              <Paper key={processInfo.pid} withBorder p="sm" radius="sm">
                <Stack gap="xs">
                  <Group justify="space-between" align="flex-start">
                    <div className="mobile-card__title">
                      <Text fw={700}>PID {processInfo.pid}</Text>
                      <Text c="dimmed" size="xs">
                        PPID {processInfo.ppid ?? "-"}
                      </Text>
                    </div>
                    <ProcessActions
                      process={processInfo}
                      onKill={setKillIntent}
                    />
                  </Group>
                  {managedBadge(processInfo)}
                  <Code className="code-wrap">{processInfo.command}</Code>
                  <Code className="code-wrap">{processInfo.args}</Code>
                </Stack>
              </Paper>
            ))}
            {processes.length === 0 && (
              <Paper withBorder p="md" radius="sm">
                <Text c="dimmed" ta="center">
                  No llama-server processes found
                </Text>
              </Paper>
            )}
          </Stack>

          <Table.ScrollContainer className="processes-table" minWidth={960}>
            <Table striped highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>PID</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Command</Table.Th>
                  <Table.Th>Args</Table.Th>
                  <Table.Th ta="right">Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {processes.map((processInfo) => (
                  <Table.Tr key={processInfo.pid}>
                    <Table.Td>
                      <Text fw={700}>{processInfo.pid}</Text>
                      <Text c="dimmed" size="xs">
                        PPID {processInfo.ppid ?? "-"}
                      </Text>
                    </Table.Td>
                    <Table.Td>{managedBadge(processInfo)}</Table.Td>
                    <Table.Td>
                      <Code>{processInfo.command}</Code>
                    </Table.Td>
                    <Table.Td>
                      <Code>{processInfo.args}</Code>
                    </Table.Td>
                    <Table.Td>
                      <ProcessActions
                        process={processInfo}
                        onKill={setKillIntent}
                      />
                    </Table.Td>
                  </Table.Tr>
                ))}
                {processes.length === 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={5}>
                      <Text c="dimmed" ta="center" py="lg">
                        No llama-server processes found
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Stack>
      </Paper>

      <Modal
        opened={Boolean(killIntent)}
        onClose={() => setKillIntent(null)}
        title={killIntent ? killLabel(killIntent.force) : "Kill process"}
        centered
      >
        {killIntent && (
          <Stack gap="sm">
            <Alert color={killIntent.force ? "red" : "yellow"}>
              This sends {killIntent.force ? "SIGKILL" : "SIGTERM"} to an
              unmanaged llama-server process.
            </Alert>
            <Code className="code-wrap">pid {killIntent.process.pid}</Code>
            <Code className="code-wrap">{killIntent.process.args}</Code>
            <Group justify="flex-end" gap="xs">
              <Button variant="default" onClick={() => setKillIntent(null)}>
                Cancel
              </Button>
              <Button
                color={killIntent.force ? "red" : "yellow"}
                leftSection={
                  killIntent.force ? (
                    <ShieldAlert size={16} />
                  ) : (
                    <Power size={16} />
                  )
                }
                loading={killMutation.isPending}
                onClick={() => killMutation.mutate(killIntent)}
              >
                {killLabel(killIntent.force)}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}
