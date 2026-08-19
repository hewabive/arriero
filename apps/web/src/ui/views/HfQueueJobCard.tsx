import type { HfDownloadQueueJob } from "@arriero/core";
import {
  Badge,
  Button,
  Collapse,
  Group,
  Paper,
  Progress,
  ScrollArea,
  Stack,
  Text,
} from "@mantine/core";
import { X } from "lucide-react";

import {
  JobPanelControls,
  useJobPanelCollapse,
} from "../components/JobPanelControls";
import type { ByteRate } from "../utils/byte-rate";
import { hfDownloadJobStatusColor } from "../utils/job-status";
import { formatBytes, formatBytesPerSecond } from "../utils/models";
import { formatElapsed, formatEtaSeconds } from "../utils/time";
import { HfJobFileRow } from "./HfJobFileRow";

export function hfJobPercent(job: HfDownloadQueueJob): number | null {
  if (job.totalBytes <= 0) {
    return null;
  }
  return Math.min(
    100,
    Math.round((job.downloadedBytes / job.totalBytes) * 100),
  );
}

export function hfJobProgressLine(
  job: HfDownloadQueueJob,
  rate: ByteRate | null,
): string {
  const parts: string[] = [
    `${formatBytes(job.downloadedBytes)} of ${formatBytes(job.totalBytes)}`,
  ];
  if (job.status === "running" && rate) {
    if (rate.stalled) {
      parts.push("stalled");
    } else if (rate.bps !== null) {
      parts.push(formatBytesPerSecond(rate.bps));
      const remaining = job.totalBytes - job.downloadedBytes;
      if (rate.bps > 0 && remaining > 0) {
        const eta = formatEtaSeconds(remaining / rate.bps);
        if (eta) {
          parts.push(`${eta} left`);
        }
      }
    }
  }
  if (job.startedAt) {
    const elapsed = formatElapsed(job.startedAt, job.finishedAt);
    if (elapsed) {
      parts.push(elapsed);
    }
  }
  if (job.connections !== null && job.connections > 1) {
    parts.push(`${job.connections} connections`);
  }
  return parts.join(" · ");
}

export function HfQueueJobCard(props: {
  job: HfDownloadQueueJob;
  rate: ByteRate | null;
  canceling: boolean;
  onCancel?: (() => void) | undefined;
  onDismiss?: (() => void) | undefined;
  onSkipFile?: ((path: string) => void) | undefined;
  highlighted?: boolean | undefined;
}) {
  const { job } = props;
  const [detailsOpened, toggleDetails] = useJobPanelCollapse(
    job.id,
    job.status === "succeeded",
  );
  const percent = hfJobPercent(job);
  const running = job.status === "running";

  return (
    <Paper
      withBorder
      p="sm"
      radius="sm"
      {...(props.highlighted ? { className: "hf-queue-card--highlight" } : {})}
    >
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2} style={{ flex: "1 1 auto", minWidth: 0 }}>
            <Group gap="xs" wrap="wrap">
              <Text fw={600} size="sm">
                {job.repoId}
              </Text>
              <Badge
                color={hfDownloadJobStatusColor(job.status)}
                variant="light"
              >
                {job.status}
              </Badge>
              {percent !== null && (
                <Badge color="blue" variant="outline">
                  {percent}%
                </Badge>
              )}
            </Group>
            <Text c="dimmed" size="xs" style={{ overflowWrap: "anywhere" }}>
              {hfJobProgressLine(job, props.rate)}
            </Text>
            {running && job.message && (
              <Text c="dimmed" size="xs" style={{ overflowWrap: "anywhere" }}>
                {job.message}
              </Text>
            )}
          </Stack>
          <Group gap={4} wrap="nowrap">
            {running && props.onCancel && (
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
              subject="download"
              opened={detailsOpened}
              onToggle={toggleDetails}
              onDismiss={props.onDismiss}
            />
          </Group>
        </Group>

        {percent !== null && (
          <Progress
            value={percent}
            color={hfDownloadJobStatusColor(job.status)}
            animated={running}
            striped={running}
          />
        )}

        <Collapse in={detailsOpened}>
          <Stack gap="xs">
            <ScrollArea.Autosize mah={260} type="auto" offsetScrollbars>
              <Stack gap={3}>
                {job.files.map((file) => (
                  <HfJobFileRow
                    key={file.path}
                    file={file}
                    action={
                      props.onSkipFile &&
                      (file.status === "pending" ||
                        file.status === "downloading")
                        ? {
                            label: "Skip file",
                            onAction: () => props.onSkipFile?.(file.path),
                          }
                        : undefined
                    }
                  />
                ))}
              </Stack>
            </ScrollArea.Autosize>
            {job.error && (
              <Text size="xs" c="red" style={{ overflowWrap: "anywhere" }}>
                {job.error}
              </Text>
            )}
          </Stack>
        </Collapse>
      </Stack>
    </Paper>
  );
}
