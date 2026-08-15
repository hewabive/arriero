import { Badge, Group, Paper, Stack, Text } from "@mantine/core";

import { type InstanceFormController } from "./use-instance-form";

export function InstanceFormPreflightSection({
  fm,
}: {
  fm: InstanceFormController;
}) {
  return (
    <Paper withBorder p="sm" radius="sm">
      <Group justify="space-between" mb="xs">
        <Text fw={600} size="sm">
          Preflight preview
        </Text>
        <Badge
          color={
            fm.draftPreview.error
              ? "red"
              : fm.preflightPreviewQuery.data?.data
                ? fm.preflightPreviewQuery.data.data.ok
                  ? "green"
                  : "red"
                : "gray"
          }
          variant="light"
        >
          {fm.draftPreview.error
            ? "invalid"
            : fm.preflightPreviewQuery.data?.data
              ? fm.preflightPreviewQuery.data.data.ok
                ? "can start"
                : "needs attention"
              : "checking"}
        </Badge>
      </Group>
      <Stack gap={4}>
        {fm.draftPreview.error && (
          <Text c="red" size="xs">
            {fm.draftPreview.error}
          </Text>
        )}
        {!fm.draftPreview.error &&
          (fm.preflightPreviewQuery.data?.data.issues ?? []).map(
            (issue, index) => (
              <Text
                key={`${issue.field}-${index}`}
                c={issue.level === "error" ? "red" : "yellow"}
                size="xs"
              >
                {issue.field}: {issue.message}
              </Text>
            ),
          )}
        {!fm.draftPreview.error &&
          fm.preflightPreviewQuery.data?.data.issues.length === 0 && (
            <Text c="dimmed" size="xs">
              Binary, model, working directory and port look valid.
            </Text>
          )}
        {fm.preflightPreviewQuery.isError && (
          <Text c="red" size="xs">
            {(fm.preflightPreviewQuery.error as Error).message}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
