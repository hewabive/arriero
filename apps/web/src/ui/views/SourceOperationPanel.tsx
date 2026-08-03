import type { SourceRepositoryOperationJob } from "@arriero/core";
import {
  Badge,
  Button,
  Code,
  Group,
  Paper,
  Progress,
  ScrollArea,
  Stack,
  Text,
} from "@mantine/core";
import { X } from "lucide-react";

function statusColor(status: SourceRepositoryOperationJob["status"]) {
  if (status === "succeeded") return "green";
  if (status === "running") return "blue";
  if (status === "canceled") return "gray";
  return "red";
}

function phaseLabel(phase: SourceRepositoryOperationJob["phase"]) {
  if (phase === "checking-out") return "checking out";
  return phase;
}

function elapsed(job: SourceRepositoryOperationJob) {
  const start = Date.parse(job.startedAt);
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const seconds = Math.max(0, Math.floor((end - start) / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

export function SourceOperationPanel(props: {
  job: SourceRepositoryOperationJob | null;
  canceling: boolean;
  onCancel: () => void;
}) {
  const { job } = props;
  if (!job) return null;
  const duration = elapsed(job);

  return (
    <Paper withBorder p="sm" radius="sm">
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Stack gap={2}>
            <Group gap="xs">
              <Text fw={600} size="sm">
                Source {job.operation}
              </Text>
              <Badge color={statusColor(job.status)} variant="light">
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
            <Text c="dimmed" size="xs">
              {job.message ?? "Waiting for progress."}
              {duration ? ` · ${duration}` : ""}
            </Text>
          </Stack>
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
        </Group>

        {job.progress !== null && (
          <Progress
            value={job.progress}
            color={statusColor(job.status)}
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
    </Paper>
  );
}
