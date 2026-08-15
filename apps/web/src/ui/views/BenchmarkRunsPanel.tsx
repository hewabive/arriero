import type { BenchmarkRun } from "@arriero/core";
import {
  ActionIcon,
  Badge,
  Group,
  Paper,
  Progress,
  Stack,
  Text,
  Title,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { Square, Trash2 } from "lucide-react";

import { countLabel } from "../utils/plural";
import { formatLocalDateTime } from "../utils/time";
import { buildStatusColor } from "./build-view-helpers";
import type { BenchmarkViewController } from "./use-benchmark-view";

function runTitle(run: BenchmarkRun): string {
  return run.label ?? run.id.slice(0, 8);
}

function runMeta(run: BenchmarkRun): string {
  const created = formatLocalDateTime(run.createdAt);
  const parts = [run.scenario.target.instanceName, created];
  if (run.summary) {
    parts.push(countLabel(run.summary.requestCount, "request"));
    parts.push(`${(run.summary.wallMs / 1000).toFixed(1)} s`);
    const rate = run.summary.headline?.decodeTokensPerSecond ?? null;
    if (rate !== null) {
      parts.push(`${rate.toFixed(1)} tok/s`);
    }
  }
  return parts.join(" · ");
}

export function BenchmarkRunsPanel({ fm }: { fm: BenchmarkViewController }) {
  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <Title order={4}>Runs</Title>
        {fm.runs.length === 0 && (
          <Text c="dimmed" size="sm">
            No benchmark runs yet — configure and start one.
          </Text>
        )}
        {fm.runs.map((run) => {
          const progress = run.progress;
          const selected = fm.selectedRun?.id === run.id;
          return (
            <Paper
              key={run.id}
              withBorder
              p="xs"
              radius="sm"
              style={
                selected
                  ? { borderColor: "var(--mantine-color-blue-5)" }
                  : undefined
              }
            >
              <Group gap="xs" wrap="nowrap" align="center">
                <UnstyledButton
                  style={{ flex: 1, minWidth: 0 }}
                  onClick={() => fm.selectRun(run.id)}
                >
                  <Group gap="xs" wrap="nowrap">
                    <Badge
                      color={buildStatusColor(run.status)}
                      variant="light"
                      style={{ flex: "0 0 auto" }}
                    >
                      {run.status}
                    </Badge>
                    <Stack gap={0} style={{ minWidth: 0 }}>
                      <Text size="sm" fw={500} truncate>
                        {runTitle(run)}
                      </Text>
                      <Text size="xs" c="dimmed" truncate>
                        {runMeta(run)}
                      </Text>
                    </Stack>
                  </Group>
                </UnstyledButton>
                {run.status === "running" && (
                  <Tooltip label="Cancel run">
                    <ActionIcon
                      variant="subtle"
                      color="orange"
                      onClick={() => fm.cancelRun(run.id)}
                    >
                      <Square size={16} />
                    </ActionIcon>
                  </Tooltip>
                )}
                {run.status !== "running" && (
                  <Tooltip label="Delete run">
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      onClick={() => fm.deleteRun(run.id)}
                    >
                      <Trash2 size={16} />
                    </ActionIcon>
                  </Tooltip>
                )}
              </Group>
              {run.status === "running" && progress && (
                <Stack gap={2} mt={6}>
                  <Progress
                    size="xs"
                    value={
                      progress.totalRequests > 0
                        ? (100 * progress.completedRequests) /
                          progress.totalRequests
                        : 0
                    }
                  />
                  <Text size="xs" c="dimmed">
                    {progress.phase} · {progress.completedRequests}/
                    {progress.totalRequests} requests ·{" "}
                    {countLabel(progress.activeRequests, "active request")}
                  </Text>
                </Stack>
              )}
            </Paper>
          );
        })}
      </Stack>
    </Paper>
  );
}
