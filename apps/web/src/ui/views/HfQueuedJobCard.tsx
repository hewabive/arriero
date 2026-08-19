import type { HfDownloadQueueJob } from "@arriero/core";
import {
  ActionIcon,
  Badge,
  Code,
  Collapse,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { ArrowDown, ArrowUp, X } from "lucide-react";

import {
  JobPanelControls,
  useJobPanelCollapse,
} from "../components/JobPanelControls";
import { formatBytes } from "../utils/models";
import { countLabel } from "../utils/plural";
import { HfJobFileRow } from "./HfJobFileRow";

export function HfQueuedJobCard(props: {
  job: HfDownloadQueueJob;
  position: number;
  isFirst: boolean;
  isLast: boolean;
  busy: boolean;
  highlighted?: boolean | undefined;
  onMove: (direction: "up" | "down") => void;
  onRemove: () => void;
  onRemoveFile: (path: string) => void;
}) {
  const { job } = props;
  const [detailsOpened, toggleDetails] = useJobPanelCollapse(job.id, true);

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
              <Badge color="gray" variant="outline">
                #{props.position}
              </Badge>
              <Text fw={600} size="sm">
                {job.repoId}
              </Text>
              <Text size="xs" c="dimmed">
                {countLabel(job.files.length, "file")} ·{" "}
                {formatBytes(job.totalBytes)}
              </Text>
            </Group>
            <Text c="dimmed" size="xs" style={{ overflowWrap: "anywhere" }}>
              <Code>{job.destDir}</Code>
            </Text>
          </Stack>
          <Group gap={4} wrap="nowrap">
            <Tooltip label="Move up">
              <ActionIcon
                size="sm"
                variant="subtle"
                color="gray"
                disabled={props.isFirst || props.busy}
                onClick={() => props.onMove("up")}
                aria-label={`Move ${job.repoId} up in the queue`}
              >
                <ArrowUp size={14} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Move down">
              <ActionIcon
                size="sm"
                variant="subtle"
                color="gray"
                disabled={props.isLast || props.busy}
                onClick={() => props.onMove("down")}
                aria-label={`Move ${job.repoId} down in the queue`}
              >
                <ArrowDown size={14} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Remove from queue">
              <ActionIcon
                size="sm"
                variant="subtle"
                color="red"
                disabled={props.busy}
                onClick={props.onRemove}
                aria-label={`Remove ${job.repoId} from the queue`}
              >
                <X size={14} />
              </ActionIcon>
            </Tooltip>
            <JobPanelControls
              subject="queued download"
              opened={detailsOpened}
              onToggle={toggleDetails}
              size="sm"
            />
          </Group>
        </Group>

        <Collapse in={detailsOpened}>
          <ScrollArea.Autosize mah={220} type="auto" offsetScrollbars>
            <Stack gap={3}>
              {job.files.map((file) => (
                <HfJobFileRow
                  key={file.path}
                  file={file}
                  action={{
                    label: "Remove file",
                    onAction: () => props.onRemoveFile(file.path),
                    disabled: props.busy,
                  }}
                />
              ))}
            </Stack>
          </ScrollArea.Autosize>
        </Collapse>
      </Stack>
    </Paper>
  );
}
