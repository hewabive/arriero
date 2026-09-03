import { Badge, Group, Paper, Select, Stack, Text } from "@mantine/core";

import {
  effectiveTargetEviction,
  instanceEvictionLimitLabel,
  type TargetEvictionContext,
} from "./eviction-policy";

const TARGET_EVICTION_OPTIONS = [
  { value: "inherit", label: "Use instance policy" },
  { value: "protected", label: "Protect this target" },
];

export function TargetEvictionPolicyField({
  context,
  targetAllowsEviction,
  onChange,
}: {
  context: TargetEvictionContext;
  targetAllowsEviction: boolean;
  onChange: (value: boolean) => void;
}) {
  const effective = effectiveTargetEviction(targetAllowsEviction, context);
  const notManaged = context.kind === "not-managed";

  return (
    <Stack gap="xs">
      <Select
        label="Target eviction permission"
        description={
          notManaged
            ? "Not used for external endpoints."
            : "Use the instance-wide limit, or protect this route from eviction by competing proxy requests."
        }
        data={TARGET_EVICTION_OPTIONS}
        value={targetAllowsEviction ? "inherit" : "protected"}
        disabled={notManaged}
        allowDeselect={false}
        onChange={(value) => onChange(value !== "protected")}
      />
      <Paper withBorder p="sm" radius="sm">
        <Stack gap={4}>
          <Group justify="space-between" align="center" wrap="wrap">
            <Text size="sm">Instance limit</Text>
            <Text size="sm" fw={500}>
              {instanceEvictionLimitLabel(context)}
            </Text>
          </Group>
          <Group justify="space-between" align="center" wrap="wrap">
            <Text size="sm">Effective policy</Text>
            <Badge color={effective.color} variant="light">
              {effective.label}
            </Badge>
          </Group>
          <Text c="dimmed" size="xs">
            {effective.detail}
          </Text>
        </Stack>
      </Paper>
    </Stack>
  );
}
