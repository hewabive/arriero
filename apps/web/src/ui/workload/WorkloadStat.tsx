import { Stack, Text } from "@mantine/core";

export function WorkloadStat(props: { label: string; value: string }) {
  return (
    <Stack gap={0}>
      <Text size="xs" c="dimmed">
        {props.label}
      </Text>
      <Text fw={600}>{props.value}</Text>
    </Stack>
  );
}
