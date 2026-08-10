import type { Instance, InstanceHealthSummary } from "@arriero/core";
import { Group, Paper, SimpleGrid, Stack, Text, Title } from "@mantine/core";

import { InstanceHealthBadge } from "../components/InstanceHealthBadge";
import { formatLocalDateTime } from "../utils/time";

const RUNNING_STATUSES = new Set<InstanceHealthSummary["status"]>([
  "ready",
  "loading",
  "degraded",
  "starting",
]);

function effectiveStatus(
  instance: Instance,
  health: InstanceHealthSummary | undefined,
): InstanceHealthSummary["status"] | Instance["status"] {
  return health?.status ?? instance.status;
}

function StatCard(props: { label: string; value: number }) {
  return (
    <Paper withBorder p="md" radius="sm">
      <Text c="dimmed" size="sm">
        {props.label}
      </Text>
      <Text fw={800} size="xl">
        {props.value}
      </Text>
    </Paper>
  );
}

function InstanceCard(props: {
  instance: Instance;
  health: InstanceHealthSummary | undefined;
  onOpenDiagnostics: () => void;
}) {
  const { instance, health } = props;
  return (
    <Paper
      withBorder
      p="sm"
      radius="sm"
      w={260}
      style={{ cursor: "pointer" }}
      onClick={props.onOpenDiagnostics}
    >
      <Stack gap={6}>
        <Text fw={700} style={{ wordBreak: "break-word" }}>
          {instance.name}
        </Text>
        <Group gap={4}>
          <InstanceHealthBadge instance={instance} health={health} />
        </Group>
        <Stack gap={2}>
          <Text c="dimmed" size="xs">
            {health?.reason ?? "Health summary is loading"}
          </Text>
          {health?.checkedAt && (
            <Text c="dimmed" size="xs">
              checked {formatLocalDateTime(health.checkedAt)}
            </Text>
          )}
        </Stack>
      </Stack>
    </Paper>
  );
}

export function DashboardView(props: {
  instances: Instance[];
  healthByInstanceId: Map<string, InstanceHealthSummary>;
  onOpenDiagnostics: (instance: Instance) => void;
}) {
  const statuses = props.instances.map((instance) =>
    effectiveStatus(instance, props.healthByInstanceId.get(instance.name)),
  );
  const counts = {
    total: props.instances.length,
    running: statuses.filter(
      (status) =>
        RUNNING_STATUSES.has(status as InstanceHealthSummary["status"]) ||
        status === "running",
    ).length,
    stale: statuses.filter((status) => status === "stale").length,
    error: statuses.filter(
      (status) => status === "error" || status === "invalid",
    ).length,
    stopped: statuses.filter((status) => status === "stopped").length,
  };

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 2, sm: 5 }}>
        <StatCard label="Total" value={counts.total} />
        <StatCard label="Running" value={counts.running} />
        <StatCard label="Stale" value={counts.stale} />
        <StatCard label="Errors" value={counts.error} />
        <StatCard label="Stopped" value={counts.stopped} />
      </SimpleGrid>

      <Paper withBorder p="md" radius="sm">
        <Stack gap="sm">
          <div className="section-heading">
            <Title order={4}>Instances</Title>
            <Text c="dimmed" size="sm">
              Health at a glance — click a card to open Diagnostics
            </Text>
          </div>

          <Group gap="xs" align="stretch">
            {props.instances.map((instance) => (
              <InstanceCard
                key={instance.name}
                instance={instance}
                health={props.healthByInstanceId.get(instance.name)}
                onOpenDiagnostics={() => props.onOpenDiagnostics(instance)}
              />
            ))}
            {props.instances.length === 0 && (
              <Paper withBorder p="md" radius="sm" w="100%">
                <Text c="dimmed" ta="center">
                  No instances configured
                </Text>
              </Paper>
            )}
          </Group>
        </Stack>
      </Paper>
    </Stack>
  );
}
