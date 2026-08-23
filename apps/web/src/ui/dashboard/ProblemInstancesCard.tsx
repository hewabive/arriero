import type { Instance, InstanceHealthSummary } from "@arriero/core";
import {
  Group,
  Paper,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { CircleCheck } from "lucide-react";

import { InstanceHealthBadge } from "../components/InstanceHealthBadge";
import { countInstanceStatuses } from "../utils/instance-status";
import { countLabel } from "../utils/plural";

const PROBLEM_STATUSES = new Set<InstanceHealthSummary["status"]>([
  "degraded",
  "stale",
  "error",
  "invalid",
]);

function hasProblem(health: InstanceHealthSummary | undefined) {
  if (!health) {
    return false;
  }
  return (
    PROBLEM_STATUSES.has(health.status) ||
    health.configDrift ||
    health.reasoningTemplateIssue !== null ||
    health.memoryAssessment?.status === "mismatch"
  );
}

export function ProblemInstancesCard(props: {
  instances: Instance[];
  healthByInstanceId: Map<string, InstanceHealthSummary>;
  onOpenDiagnostics: (instance: Instance) => void;
}) {
  const problems = props.instances
    .map((instance) => ({
      instance,
      health: props.healthByInstanceId.get(instance.name),
    }))
    .filter(({ health }) => hasProblem(health));
  const counts = countInstanceStatuses(
    props.instances,
    props.healthByInstanceId,
  );

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <div className="section-heading">
          <Title order={4}>Instances needing attention</Title>
          <Text c="dimmed" size="sm">
            Degraded, stale or misconfigured — click to open Diagnostics
          </Text>
        </div>
        {problems.length === 0 ? (
          <Group gap="xs" wrap="nowrap">
            <CircleCheck size={16} color="var(--mantine-color-green-6)" />
            <Text c="dimmed" size="sm">
              {props.instances.length === 0
                ? "No instances configured"
                : `All ${countLabel(counts.total, "instance")} look fine — ${counts.running} running`}
            </Text>
          </Group>
        ) : (
          <Stack gap={2}>
            {problems.map(({ instance, health }) => (
              <UnstyledButton
                key={instance.name}
                className="dashboard-attention-item"
                onClick={() => props.onOpenDiagnostics(instance)}
              >
                <Stack gap={4}>
                  <Group gap="xs" wrap="wrap">
                    <Text
                      fw={600}
                      size="sm"
                      style={{ wordBreak: "break-word" }}
                    >
                      {instance.name}
                    </Text>
                    <Group gap={4}>
                      <InstanceHealthBadge
                        instance={instance}
                        health={health}
                      />
                    </Group>
                  </Group>
                  {health?.reason && (
                    <Text c="dimmed" size="xs">
                      {health.reason}
                    </Text>
                  )}
                </Stack>
              </UnstyledButton>
            ))}
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}
