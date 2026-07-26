import {
  Badge,
  Box,
  Button,
  Group,
  MultiSelect,
  Paper,
  Stack,
  Text,
} from "@mantine/core";

import { type InstanceFormController } from "./use-instance-form";

function statusColor(status: string | null) {
  if (status === "running") return "green";
  if (status === "error") return "red";
  if (status === "starting" || status === "stopping") return "yellow";
  return "gray";
}

export function InstanceFormRpcWorkersSection({
  fm,
}: {
  fm: InstanceFormController;
}) {
  const empty =
    !fm.rpcWorkerCandidatesQuery.isFetching && fm.rpcWorkerOptions.length === 0;

  return (
    <Paper withBorder p="sm" radius="sm">
      <Stack gap="xs">
        <Box>
          <Text fw={600} size="sm">
            RPC workers
          </Text>
          <Text c="dimmed" size="xs">
            Offload tensor compute to remote rpc-server workers across the fleet
            via --rpc. Workers are resolved to host:port at launch; this
            orchestrator must reach them over a fast fabric. Each worker serves
            one orchestrator at a time and must be running before start.
          </Text>
        </Box>

        <MultiSelect
          placeholder={
            fm.rpcWorkerCandidatesQuery.isFetching
              ? "Loading workers..."
              : "Select rpc-worker instances"
          }
          searchable
          clearable
          data={fm.rpcWorkerOptions}
          value={fm.selectedRpcWorkerValues}
          onChange={fm.applyRpcWorkers}
          nothingFoundMessage="No rpc-worker instances in the fleet"
        />

        {fm.selectedRpcWorkers.length > 0 && (
          <Stack gap={4}>
            {fm.selectedRpcWorkers.map((worker) => (
              <Group
                key={`${worker.nodeId ?? "local"}:${worker.instanceName}`}
                justify="space-between"
                gap="xs"
              >
                <Text size="xs">
                  {worker.nodeName} / {worker.instanceName}
                </Text>
                <Badge size="xs" color={statusColor(worker.status)}>
                  {worker.status ?? "unavailable"}
                </Badge>
              </Group>
            ))}
          </Stack>
        )}

        {fm.downRpcWorkerCount > 0 && (
          <Group justify="space-between" gap="xs">
            <Text c="yellow" size="xs">
              {fm.downRpcWorkerCount} selected worker
              {fm.downRpcWorkerCount === 1 ? " is" : "s are"} not running; start
              before this instance.
            </Text>
            <Button
              size="xs"
              variant="light"
              loading={fm.startRpcWorkersPending}
              onClick={fm.startDownRpcWorkers}
            >
              Start workers
            </Button>
          </Group>
        )}

        {empty && (
          <Text c="dimmed" size="xs">
            Create an rpc-worker instance (here or on another node) to make it
            selectable.
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
