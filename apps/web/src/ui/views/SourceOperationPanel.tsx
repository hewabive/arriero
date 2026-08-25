import type { SourceRepositoryOperationJob } from "@arriero/core";
import {
  Badge,
  Button,
  Code,
  Collapse,
  Group,
  Paper,
  Progress,
  ScrollArea,
  Stack,
  Text,
} from "@mantine/core";
import { X } from "lucide-react";
import { useState } from "react";

import {
  JobPanelControls,
  useJobPanelCollapse,
} from "../components/JobPanelControls";
import { backgroundJobStatusColor } from "../utils/job-status";
import { formatElapsed } from "../utils/time";

function phaseLabel(phase: SourceRepositoryOperationJob["phase"]) {
  if (phase === "checking-out") return "checking out";
  return phase;
}

export function SourceOperationPanel(props: {
  job: SourceRepositoryOperationJob | null;
  canceling: boolean;
  onCancel: () => void;
}) {
  const { job } = props;
  const [dismissedJobId, setDismissedJobId] = useState<string | null>(null);
  const [detailsOpened, toggleDetails] = useJobPanelCollapse(
    job?.id ?? null,
    job?.status === "succeeded",
  );

  if (!job) return null;
  if (job.id === dismissedJobId) return null;
  const duration = formatElapsed(job.startedAt, job.finishedAt);

  return (
    <Paper withBorder p="sm" radius="sm">
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2} style={{ flex: "1 1 auto", minWidth: 0 }}>
            <Group gap="xs" wrap="wrap">
              <Text fw={600} size="sm">
                Source {job.operation}
              </Text>
              <Badge
                color={backgroundJobStatusColor(job.status)}
                variant="light"
              >
                {job.status}
              </Badge>
              <Badge color="gray" variant="outline">
                {phaseLabel(job.phase)}
              </Badge>
              {job.progress !== null && (
                <Badge color="blue" variant="outline">
                  {job.progress}%
                </Badge>
              )}
            </Group>
            <Text c="dimmed" size="xs" style={{ overflowWrap: "anywhere" }}>
              {job.message ?? "Waiting for progress."}
              {duration ? ` · ${duration}` : ""}
            </Text>
          </Stack>
          <Group gap={4} wrap="nowrap">
            {job.status === "running" && (
              <Button
                size="xs"
                variant="subtle"
                color="red"
                leftSection={<X size={14} />}
                loading={props.canceling}
                disabled={job.cancelRequested}
                onClick={props.onCancel}
              >
                {job.cancelRequested ? "Canceling" : "Cancel"}
              </Button>
            )}
            <JobPanelControls
              subject="source operation"
              opened={detailsOpened}
              onToggle={toggleDetails}
              onDismiss={
                job.status !== "running"
                  ? () => setDismissedJobId(job.id)
                  : undefined
              }
            />
          </Group>
        </Group>

        <Collapse expanded={detailsOpened}>
          <Stack gap="xs">
            {job.progress !== null && (
              <Progress
                value={job.progress}
                color={backgroundJobStatusColor(job.status)}
                animated={job.status === "running"}
                striped={job.status === "running"}
              />
            )}

            <ScrollArea.Autosize mah={220} type="auto" offsetScrollbars>
              <Stack gap={3}>
                {job.logLines.map((line, index) => (
                  <Code key={`${job.id}-${index}`} block>
                    {line}
                  </Code>
                ))}
                {job.logLines.length === 0 && (
                  <Text c="dimmed" size="xs">
                    Waiting for Git output…
                  </Text>
                )}
              </Stack>
            </ScrollArea.Autosize>
          </Stack>
        </Collapse>
      </Stack>
    </Paper>
  );
}
