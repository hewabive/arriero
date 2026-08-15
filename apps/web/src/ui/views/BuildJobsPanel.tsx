import {
  Badge,
  Box,
  Code,
  Group,
  Paper,
  ScrollArea,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";

import { useNarrowScreen } from "../hooks/use-narrow-screen";
import { formatLocalDateTime } from "../utils/time";
import {
  buildJobHasWarnings,
  buildStatusColor,
  buildStepColor,
  buildStepLabel,
} from "./build-view-helpers";
import { type BuildViewController } from "./use-build-view";

export function BuildJobsPanel({ fm }: { fm: BuildViewController }) {
  const compact = useNarrowScreen();
  const { jobs, selectedJob, logsQuery } = fm;
  return (
    <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
      <Box>
        <Group justify="space-between" mb="xs">
          <Text fw={600} size="sm">
            Recent jobs
          </Text>
          <Badge variant="light">{jobs.length}</Badge>
        </Group>
        {compact && (
          <Stack gap="xs">
            {jobs.map((job) => (
              <Paper key={job.id} withBorder p="sm" radius="sm">
                <Stack gap="xs">
                  <Group justify="space-between" align="flex-start">
                    <Group gap={4}>
                      <Badge
                        color={buildStatusColor(job.status)}
                        variant="light"
                      >
                        {job.status}
                      </Badge>
                      {buildJobHasWarnings(job) && (
                        <Badge color="orange" variant="light">
                          warnings
                        </Badge>
                      )}
                    </Group>
                    <Text c="dimmed" size="xs">
                      {formatLocalDateTime(job.startedAt)}
                    </Text>
                  </Group>
                  {job.error && (
                    <Text c="red" size="xs">
                      {job.error}
                    </Text>
                  )}
                  <Group gap={4}>
                    {job.steps.map((item) => (
                      <Badge
                        key={item.name}
                        color={buildStepColor(item.status)}
                        variant="outline"
                      >
                        {buildStepLabel(item.name)}
                      </Badge>
                    ))}
                  </Group>
                  <Text c="dimmed" size="xs" className="text-wrap">
                    {job.binaryPath ?? "-"}
                  </Text>
                </Stack>
              </Paper>
            ))}
            {jobs.length === 0 && (
              <Paper withBorder p="md" radius="sm">
                <Text c="dimmed" ta="center">
                  No build jobs yet
                </Text>
              </Paper>
            )}
          </Stack>
        )}

        {!compact && (
          <Table.ScrollContainer minWidth={720}>
            <Table striped highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Started</Table.Th>
                  <Table.Th>Steps</Table.Th>
                  <Table.Th>Binary</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {jobs.map((job) => (
                  <Table.Tr key={job.id}>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        <Badge
                          color={buildStatusColor(job.status)}
                          variant="light"
                        >
                          {job.status}
                        </Badge>
                        {buildJobHasWarnings(job) && (
                          <Badge color="orange" variant="light">
                            warnings
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">
                        {formatLocalDateTime(job.startedAt)}
                      </Text>
                      {job.error && (
                        <Tooltip
                          label={job.error}
                          multiline
                          maw={420}
                          withArrow
                        >
                          <Text
                            c="red"
                            size="xs"
                            lineClamp={1}
                            style={{ cursor: "help" }}
                          >
                            {job.error}
                          </Text>
                        </Tooltip>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        {job.steps.map((item) => (
                          <Badge
                            key={item.name}
                            color={buildStepColor(item.status)}
                            variant="outline"
                          >
                            {buildStepLabel(item.name)}
                          </Badge>
                        ))}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" lineClamp={1}>
                        {job.binaryPath ?? "-"}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
                {jobs.length === 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={4}>
                      <Text c="dimmed" ta="center" py="lg">
                        No build jobs yet
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Box>

      <Box>
        <Group justify="space-between" mb="xs">
          <Text fw={600} size="sm">
            Build log
          </Text>
          <Badge
            color={selectedJob ? buildStatusColor(selectedJob.status) : "gray"}
            variant="light"
          >
            {selectedJob?.status ?? "idle"}
          </Badge>
        </Group>
        <Text c="dimmed" size="xs" lineClamp={1} mb="xs">
          {logsQuery.data?.data.logPath ??
            selectedJob?.logPath ??
            "No log file yet"}
        </Text>
        <ScrollArea h={300} type="auto" offsetScrollbars>
          <Stack gap={4}>
            {logsQuery.data?.data.lines.map((line, index) => (
              <Code key={`${selectedJob?.id}-${index}`} block>
                {line}
              </Code>
            ))}
            {(!logsQuery.data || logsQuery.data.data.lines.length === 0) && (
              <Text c="dimmed" size="sm" ta="center" py="lg">
                No build log yet
              </Text>
            )}
          </Stack>
        </ScrollArea>
      </Box>
    </SimpleGrid>
  );
}
