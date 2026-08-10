import type { SourceRepositoryOperationJob } from "@arriero/core";
import {
  ActionIcon,
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
  Tooltip,
} from "@mantine/core";
import { ChevronDown, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
  const [dismissedJobId, setDismissedJobId] = useState<string | null>(null);
  const [detailsOpened, setDetailsOpened] = useState(true);
  const previousJobIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!job) return;
    if (previousJobIdRef.current !== job.id) {
      previousJobIdRef.current = job.id;
      setDetailsOpened(job.status !== "succeeded");
      return;
    }
    if (job.status === "succeeded") {
      setDetailsOpened(false);
    }
  }, [job?.id, job?.status]);

  if (!job) return null;
  if (job.id === dismissedJobId) return null;
  const duration = elapsed(job);

  return (
    <Paper withBorder p="sm" radius="sm">
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2} style={{ flex: "1 1 auto", minWidth: 0 }}>
            <Group gap="xs" wrap="wrap">
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
            <Tooltip
              label={detailsOpened ? "Collapse details" : "Expand details"}
            >
              <ActionIcon
                variant="subtle"
                color="gray"
                onClick={() => setDetailsOpened((opened) => !opened)}
                aria-label={
                  detailsOpened
                    ? "Collapse source operation details"
                    : "Expand source operation details"
                }
              >
                <ChevronDown
                  size={16}
                  style={{
                    transform: detailsOpened ? "rotate(180deg)" : undefined,
                    transition: "transform 150ms ease",
                  }}
                />
              </ActionIcon>
            </Tooltip>
            {job.status !== "running" && (
              <Tooltip label="Dismiss">
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  onClick={() => setDismissedJobId(job.id)}
                  aria-label="Dismiss source operation result"
                >
                  <X size={16} />
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
        </Group>

        <Collapse in={detailsOpened}>
          <Stack gap="xs">
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
        </Collapse>
      </Stack>
    </Paper>
  );
}
