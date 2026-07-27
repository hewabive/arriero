import type { InstanceHealthSummary, LogTail } from "@arriero/core";
import {
  Badge,
  Button,
  Code,
  Group,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Text,
} from "@mantine/core";
import { Square } from "lucide-react";

import type { LaunchMonitor } from "../utils/launch";
import { formatLocalDateTime } from "../utils/time";
import { isStartupStatus } from "./instance-details-helpers";

const launchMonitorTimeoutMs = 5 * 60 * 1000;

function startupStage(health: InstanceHealthSummary | undefined) {
  if (!health) {
    return {
      label: "checking",
      color: "gray",
      text: "Collecting runtime state.",
    };
  }
  if (health.status === "ready") {
    return {
      label: "ready",
      color: "green",
      text: "Server is ready to accept requests.",
    };
  }
  if (health.status === "starting" || health.status === "loading") {
    return {
      label: health.status,
      color: "yellow",
      text: "Model process is starting and readiness is still pending.",
    };
  }
  if (health.status === "degraded") {
    return {
      label: "degraded",
      color: "orange",
      text: "Server is reachable, but warnings or non-blocking issues were detected.",
    };
  }
  if (health.status === "invalid") {
    return {
      label: "invalid",
      color: "red",
      text: "Configuration has blocking preflight issues.",
    };
  }
  if (health.status === "error") {
    return { label: "error", color: "red", text: "Startup or runtime failed." };
  }
  if (health.status === "stale") {
    return {
      label: "stale",
      color: "orange",
      text: "A process exists outside the current supervisor.",
    };
  }
  return {
    label: health.status,
    color: "gray",
    text: "Instance is not running.",
  };
}

function importantStartupLines(
  logTail: LogTail | undefined,
  statusSummary: InstanceHealthSummary["logSummary"] | undefined,
) {
  const interesting =
    /\b(error|fatal|failed|exception|server is listening|http server listening|listening on|starting the main loop|model loaded|loading model|llama_model_loader|offload|warming up|ready)\b/i;
  const lines = [
    ...(statusSummary?.errors ?? []),
    ...(statusSummary?.notices ?? []),
    ...(logTail?.lines.filter((line) => interesting.test(line)) ?? []),
  ]
    .map((line) => line.trim())
    .filter(Boolean);

  return [...new Set(lines)].slice(-8);
}

function formatElapsed(ms: number | null) {
  if (ms === null || !Number.isFinite(ms) || ms < 0) {
    return "-";
  }
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function LaunchMonitorPanel(props: {
  health: InstanceHealthSummary | undefined;
  runtime: InstanceHealthSummary["runtime"] | undefined;
  logTail: LogTail | undefined;
  statusSummary: InstanceHealthSummary["logSummary"] | undefined;
  monitor: LaunchMonitor | null;
  nowMs: number;
  onStop: () => void;
  stopping: boolean;
}) {
  const healthIsFresh =
    !props.monitor ||
    !props.health ||
    Date.parse(props.health.checkedAt) >= Date.parse(props.monitor.startedAt);
  const effectiveHealth = healthIsFresh ? props.health : undefined;
  const startup =
    props.monitor && !effectiveHealth
      ? {
          label: "starting",
          color: "yellow",
          text: "Start command was accepted; waiting for the first health update.",
        }
      : startupStage(effectiveHealth);
  const startupLines = importantStartupLines(
    props.logTail,
    props.statusSummary,
  ).slice(-5);
  const loadProgress = props.statusSummary?.loadProgress;
  const startedAt =
    props.monitor?.startedAt ?? props.runtime?.startedAt ?? null;
  const elapsedMs = startedAt ? props.nowMs - Date.parse(startedAt) : null;
  const timedOut = Boolean(
    props.monitor &&
    (!effectiveHealth || isStartupStatus(effectiveHealth.status)) &&
    elapsedMs !== null &&
    elapsedMs > launchMonitorTimeoutMs,
  );

  return (
    <Paper withBorder p="sm" radius="sm">
      <Group justify="space-between" align="flex-start" mb="xs">
        <Stack gap={2}>
          <Group gap="xs">
            <Text fw={600} size="sm">
              Launch monitor
            </Text>
            <Badge color={timedOut ? "orange" : startup.color} variant="light">
              {timedOut ? "loading too long" : startup.label}
            </Badge>
          </Group>
          <Text
            c={
              effectiveHealth?.status === "error" ||
              effectiveHealth?.status === "invalid"
                ? "red"
                : "dimmed"
            }
            size="sm"
          >
            {timedOut
              ? "Startup is still pending after 5 minutes; the process was not stopped."
              : startup.text}
          </Text>
        </Stack>
        <Button
          size="xs"
          variant="light"
          color="yellow"
          leftSection={<Square size={14} />}
          loading={props.stopping}
          disabled={
            props.stopping ||
            (!props.monitor && !effectiveHealth?.actions.canStop)
          }
          onClick={props.onStop}
        >
          Stop
        </Button>
      </Group>
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs">
        <Text size="sm">PID: {props.runtime?.pid ?? "-"}</Text>
        <Text size="sm">Elapsed: {formatElapsed(elapsedMs)}</Text>
        <Text size="sm">Started: {formatLocalDateTime(startedAt)}</Text>
      </SimpleGrid>
      {loadProgress && (
        <Stack gap={4} mt="xs">
          <Group justify="space-between">
            <Text fw={600} size="xs">
              Model load
            </Text>
            <Text c="dimmed" size="xs">
              {loadProgress.percent === null
                ? loadProgress.stage
                : `${loadProgress.percent}%`}
            </Text>
          </Group>
          <Progress
            animated={loadProgress.stage !== "ready"}
            color={
              loadProgress.stage === "error"
                ? "red"
                : loadProgress.stage === "ready"
                  ? "green"
                  : "blue"
            }
            radius="xs"
            size="md"
            striped={loadProgress.stage !== "ready"}
            value={
              loadProgress.percent ??
              (isStartupStatus(effectiveHealth?.status) ? 35 : 0)
            }
          />
          <Text c={loadProgress.stage === "error" ? "red" : "dimmed"} size="xs">
            {loadProgress.message}
            {loadProgress.estimated ? " Estimated from logs." : ""}
          </Text>
        </Stack>
      )}
      <Stack gap={4} mt="xs">
        {startupLines.map((line, index) => (
          <Code key={`${index}-${line}`} block>
            {line}
          </Code>
        ))}
        {startupLines.length === 0 && (
          <Text c="dimmed" size="xs">
            No startup milestones in logs yet.
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
