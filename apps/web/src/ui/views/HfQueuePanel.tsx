import {
  Button,
  Collapse,
  Group,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { forwardRef, useState } from "react";

import { countLabel } from "../utils/plural";
import { HfQueueJobCard } from "./HfQueueJobCard";
import { HfQueuedJobCard } from "./HfQueuedJobCard";
import { useHfQueue } from "./use-hf-queue";

export const HfQueuePanel = forwardRef<
  HTMLDivElement,
  { highlightJobId: string | null }
>(function HfQueuePanel(props, ref) {
  const queue = useHfQueue();
  const [historyOpened, setHistoryOpened] = useState(false);
  const { active, queued, history } = queue;

  if (!active && queued.length === 0 && history.length === 0) {
    return null;
  }

  const summary = [
    active ? "1 active" : null,
    queued.length > 0 ? countLabel(queued.length, "queued download") : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Paper withBorder p="md" radius="sm" ref={ref}>
      <Stack gap="sm">
        <Group justify="space-between" wrap="wrap">
          <Group gap="xs">
            <Title order={4}>Download queue</Title>
            {summary && (
              <Text size="sm" c="dimmed">
                {summary}
              </Text>
            )}
          </Group>
        </Group>

        {!active && queued.length === 0 && (
          <Text size="sm" c="dimmed">
            The queue is empty — pick files in the repository browser above.
          </Text>
        )}

        {active && (
          <HfQueueJobCard
            job={active}
            rate={queue.rate}
            canceling={queue.pending.cancelId === active.id}
            onCancel={() => queue.cancel(active.id)}
            onSkipFile={(path) => queue.skipFiles(active.id, [path])}
            highlighted={props.highlightJobId === active.id}
          />
        )}

        {queued.map((job, index) => (
          <HfQueuedJobCard
            key={job.id}
            job={job}
            position={index + 1}
            isFirst={index === 0}
            isLast={index === queued.length - 1}
            busy={queue.pending.reorder || queue.pending.removeId === job.id}
            highlighted={props.highlightJobId === job.id}
            onMove={(direction) => queue.move(job.id, direction)}
            onRemove={() => queue.remove(job.id)}
            onRemoveFile={(path) => queue.skipFiles(job.id, [path])}
          />
        ))}

        {history.length > 0 && (
          <Stack gap="xs">
            <Group gap="xs" justify="space-between" wrap="wrap">
              <Button
                variant="subtle"
                size="compact-sm"
                color="gray"
                leftSection={
                  historyOpened ? (
                    <ChevronDown size={14} />
                  ) : (
                    <ChevronRight size={14} />
                  )
                }
                onClick={() => setHistoryOpened((value) => !value)}
              >
                Recent ({history.length})
              </Button>
              {historyOpened && (
                <Button
                  variant="subtle"
                  size="compact-sm"
                  color="gray"
                  leftSection={<Trash2 size={14} />}
                  loading={queue.pending.clear}
                  onClick={() => queue.clearHistory()}
                >
                  Clear
                </Button>
              )}
            </Group>
            <Collapse in={historyOpened}>
              <Stack gap="xs">
                {history.map((job) => (
                  <HfQueueJobCard
                    key={job.id}
                    job={job}
                    rate={null}
                    canceling={false}
                    onDismiss={() => queue.remove(job.id)}
                  />
                ))}
              </Stack>
            </Collapse>
          </Stack>
        )}
      </Stack>
    </Paper>
  );
});
