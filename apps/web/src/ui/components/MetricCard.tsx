import { Divider, Group, Paper, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";

export function MetricCard(props: {
  title?: ReactNode;
  meta?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const hasHeader = Boolean(props.title) || Boolean(props.meta);

  return (
    <Paper withBorder p="sm" radius="sm">
      <Stack gap="sm">
        {hasHeader && (
          <>
            <Group justify="space-between" gap="xs" wrap="nowrap">
              <Text fw={600} size="sm" lineClamp={1}>
                {props.title}
              </Text>
              {props.meta && (
                <Group gap={4} wrap="nowrap">
                  {props.meta}
                </Group>
              )}
            </Group>
            <Divider />
          </>
        )}

        {props.children}

        {props.footer && (
          <>
            <Divider />
            {props.footer}
          </>
        )}
      </Stack>
    </Paper>
  );
}
